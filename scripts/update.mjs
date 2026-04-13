import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const SITE_DIR = path.join(ROOT, "site");
const MINDMAP_DIR = path.join(SITE_DIR, "mindmaps");
const EDGE_PATHS = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const MAX_PAGES_PER_LOCALE = numericArg(args["max-pages-per-locale"]);
const MAX_MODELS_PER_SERIES = numericArg(args["max-models-per-series"]);
const ONLY_LOCALES = args.locale ? new Set(args.locale.split(",").map((x) => x.trim())) : null;

const LOCALES = {
  en: {
    code: "en",
    name: "English",
    startUrl: "https://www.hikvision.com/en/products/",
    prefix: "/en/products/",
    sitemap: "https://www.hikvision.com/en/sitemap.xml",
    viewMoreTexts: ["View More", "View more", "More"],
    compareTexts: ["Model", "Data Sheet", "Specification"]
  },
  cn: {
    code: "cn",
    name: "中文",
    startUrl: "https://www.hikvision.com/cn/products/",
    prefix: "/cn/products/",
    sitemap: null,
    viewMoreTexts: ["查看更多", "更多", "查看产品"],
    compareTexts: ["型号", "产品列表", "规格参数", "参数"]
  }
};

const skippedSeries = new Set([
  "product-selector",
  "accessory-selector",
  "compare-page"
]);

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const executablePath = await findExecutable();
  await mkdir(path.join(DATA_DIR, "raw"), { recursive: true });
  await mkdir(MINDMAP_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath
  });

  try {
    const localeResults = {};
    for (const locale of Object.values(LOCALES)) {
      if (ONLY_LOCALES && !ONLY_LOCALES.has(locale.code)) {
        continue;
      }
      localeResults[locale.code] = await processLocale(browser, locale);
    }

    const bundle = {
      generatedAt: new Date().toISOString(),
      locales: localeResults
    };

    await writeFile(path.join(SITE_DIR, "data.json"), JSON.stringify(bundle, null, 2), "utf8");
    await writeFile(path.join(SITE_DIR, "index.html"), renderHtml(bundle), "utf8");

    console.log(`Generated site: ${path.join(SITE_DIR, "index.html")}`);
  } finally {
    await browser.close();
  }
}

async function processLocale(browser, locale) {
  console.log(`\n[${locale.code}] collecting URLs`);
  const collection = locale.sitemap
    ? await collectUrlsFromSitemap(locale)
    : await collectUrlsByCrawling(browser, locale);
  const urls = collection.urls;
  const modelParentMap = collection.modelParentMap || {};

  const limitedUrls = MAX_PAGES_PER_LOCALE ? urls.slice(0, MAX_PAGES_PER_LOCALE) : urls;
  console.log(`[${locale.code}] total URLs selected: ${limitedUrls.length}`);

  const pages = [];
  for (let index = 0; index < limitedUrls.length; index += 1) {
    const url = limitedUrls[index];
    console.log(`[${locale.code}] ${index + 1}/${limitedUrls.length} ${url}`);
    try {
      const pageData = await scrapeStaticPage(locale, url);
      if (pageData) {
        pageData.parentHint = modelParentMap[pageData.url] || null;
        pages.push(pageData);
      }
    } catch (error) {
      console.warn(`[${locale.code}] failed: ${url}`);
      console.warn(error.message);
    }
  }

  const normalized = postProcessLocale(locale, pages);
  await writeFile(
    path.join(DATA_DIR, "raw", `${locale.code}.pages.json`),
    JSON.stringify(pages, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(DATA_DIR, "raw", `${locale.code}.json`),
    JSON.stringify(normalized, null, 2),
    "utf8"
  );

  for (const series of normalized.series) {
    const filename = `${locale.code}-${series.id}.mmd`;
    await writeFile(path.join(MINDMAP_DIR, filename), series.mindmap, "utf8");
  }
  await writeFile(
    path.join(MINDMAP_DIR, `${locale.code}-overview.mmd`),
    normalized.overviewMindmap,
    "utf8"
  );

  return normalized;
}

async function collectUrlsFromSitemap(locale) {
  const xml = await fetchText(locale.sitemap);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1].trim())
    .filter((url) => url.includes(locale.prefix))
    .filter((url) => !url.includes("/amp/"))
    .filter((url) => !url.includes("/where-to-buy/"))
    .filter((url) => {
      const slug = url.split("/").filter(Boolean).at(-1)?.toLowerCase() || "";
      return !skippedSeries.has(slug);
    });

  return { urls: unique(urls), modelParentMap: {} };
}

async function collectUrlsByCrawling(browser, locale) {
  const queue = [locale.startUrl];
  const visited = new Set();
  const discovered = new Set();
  const modelParentMap = {};
  let context = null;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    discovered.add(current);

    try {
      const staticExtracted = await scrapeStaticPage(locale, current);
      let mergedLinks = [...(staticExtracted.links || [])];

      if (locale.code === "cn" && staticExtracted.hasDynamicProductList) {
        context ||= await createContext(browser, locale);
        const extracted = await scrapePage(context, locale, current, { linksOnly: true });
        mergedLinks = unique([...(extracted.links || []), ...mergedLinks]);
      }

      for (const link of unique(mergedLinks)) {
        if (!visited.has(link)) {
          if (link.includes("/pdplist/")) {
            queue.unshift(link);
          } else {
            queue.push(link);
          }
        }
        discovered.add(link);
        if (link.includes("/pdplist/")) {
          modelParentMap[normalizeProductUrl(link)] = normalizeProductUrl(current);
        }
      }
    } catch (error) {
      console.warn(`[${locale.code}] crawl failed: ${current}`);
      console.warn(error.message);
    }

    if (MAX_PAGES_PER_LOCALE && visited.size >= MAX_PAGES_PER_LOCALE) {
      break;
    }
  }

  if (context) {
    await context.close();
  }
  const prioritizedUrls = [
    ...Object.keys(modelParentMap),
    ...[...discovered].filter((url) => !(url in modelParentMap))
  ];
  return { urls: unique(prioritizedUrls), modelParentMap };
}

async function createContext(browser, locale) {
  return browser.newContext({
    locale: locale.code === "cn" ? "zh-CN" : "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  });
}

async function scrapePage(context, locale, url, options = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(locale.code === "cn" ? 2000 : 1200);
    await expandDynamicList(page, locale);

    const result = await page.evaluate(
      ({ prefix, localeCode }) => {
        const normalizeUrl = (value) => {
          if (!value) return null;
          try {
            const absolute = new URL(value, location.origin);
            absolute.hash = "";
            absolute.search = "";
            return absolute.href;
          } catch {
            return null;
          }
        };

        const clean = (value) =>
          (value || "")
            .replace(/\s+/g, " ")
            .replace(/\u00a0/g, " ")
            .trim();

        const getText = (selector) =>
          clean(document.querySelector(selector)?.textContent || "");

        const allLinks = [...document.querySelectorAll("a[href], a[data-href]")]
          .map((anchor) => normalizeUrl(anchor.getAttribute("href") || anchor.getAttribute("data-href")))
          .filter(Boolean)
          .filter((value) => value.includes(prefix))
          .filter((value) => !value.includes("/where-to-buy/"))
          .filter((value) => !value.includes("/compare-page/"));

        const breadcrumbs = [
          ...document.querySelectorAll(
            ".breadcrumb-box .nav-item .link, .breadcrumb .item, .bread-crumb a, nav[aria-label*=breadcrumb] a, .nav-item.active h1, .nav-item.active .link"
          )
        ]
          .map((node) => clean(node.textContent))
          .filter(Boolean);

        const sections = {};
        const pushSpec = (section, key, value) => {
          const finalSection = clean(section || "General");
          const finalKey = clean(key);
          const finalValue = clean(value);
          if (!finalKey || !finalValue) return;
          if (!sections[finalSection]) sections[finalSection] = {};
          sections[finalSection][finalKey] = finalValue;
        };

        document.querySelectorAll("ul.tech-specs-items-description").forEach((list) => {
          const section =
            clean(list.querySelector(".tech-specs-items-description__title--heading")?.textContent) ||
            clean(list.getAttribute("data-target")) ||
            "General";
          list.querySelectorAll("li.tech-specs-items-description-list").forEach((item) => {
            const key = item.querySelector(".tech-specs-items-description__title")?.textContent;
            const value = item.querySelector(".tech-specs-items-description__title-details")?.textContent;
            pushSpec(section, key, value);
          });
        });

        document.querySelectorAll("table").forEach((table) => {
          let section =
            clean(table.closest("section, .module, .tab-pane, .component")?.querySelector("h2,h3,h4")?.textContent) ||
            "General";
          table.querySelectorAll("tr").forEach((row) => {
            const cells = [...row.querySelectorAll("th, td")].map((cell) => clean(cell.textContent)).filter(Boolean);
            if (cells.length >= 2) {
              if (cells.length === 2) {
                pushSpec(section, cells[0], cells[1]);
              } else if (cells.length === 1) {
                section = cells[0];
              }
            }
          });
        });

        document.querySelectorAll("dl").forEach((dl) => {
          const section =
            clean(dl.closest("section, .module, .tab-pane, .component")?.querySelector("h2,h3,h4")?.textContent) ||
            "General";
          const dts = [...dl.querySelectorAll("dt")];
          const dds = [...dl.querySelectorAll("dd")];
          for (let i = 0; i < Math.min(dts.length, dds.length); i += 1) {
            pushSpec(section, dts[i]?.textContent, dds[i]?.textContent);
          }
        });

        const title = clean(document.title);
        const productName =
          getText(".product_title_item") ||
          getText("h1") ||
          getText(".product-title") ||
          getText(".product-name") ||
          getText(".common-title") ||
          title;

        const description =
          document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || "";

        const lastModified =
          document.querySelector('meta[name="timestamp"]')?.getAttribute("content") ||
          document.querySelector('meta[property="article:modified_time"]')?.getAttribute("content") ||
          "";

        const dataSheetLinks = [...document.querySelectorAll("a[href]")]
          .map((anchor) => anchor.getAttribute("href"))
          .filter((href) => href && /\.pdf($|\?)/i.test(href))
          .map((href) => normalizeUrl(href));

        const headings = [...document.querySelectorAll("h1,h2,h3")]
          .map((node) => clean(node.textContent))
          .filter(Boolean);

        return {
          url: location.href,
          locale: localeCode,
          title,
          productName,
          description,
          lastModified,
          breadcrumbs,
          headings,
          links: [...new Set(allLinks)],
          specs: sections,
          dataSheets: [...new Set(dataSheetLinks)]
        };
      },
      { prefix: locale.prefix, localeCode: locale.code }
    );

    if (options.linksOnly) {
      return result;
    }

    result.url = normalizeProductUrl(result.url);
    result.links = result.links.map(normalizeProductUrl).filter(Boolean);
    result.pathSegments = productSegments(result.url, locale);
    result.pageType = inferPageType(result);
    return result;
  } finally {
    await page.close();
  }
}

async function scrapeStaticPage(locale, url) {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const clean = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\u00a0/g, " ")
      .trim();

  const normalizeUrl = (value) => {
    if (!value) return null;
    try {
      const absolute = new URL(value, url);
      absolute.hash = "";
      absolute.search = "";
      if (!absolute.pathname.endsWith("/")) {
        absolute.pathname += "/";
      }
      return absolute.href;
    } catch {
      return null;
    }
  };

  const links = unique(
    $("a[href], a[data-href]")
      .map((_, element) => normalizeUrl($(element).attr("href") || $(element).attr("data-href")))
      .get()
      .filter(Boolean)
      .filter((value) => value.includes(locale.prefix))
      .filter((value) => !value.includes("/compare-page/"))
      .filter((value) => !value.includes("/where-to-buy/"))
  );

  const breadcrumbs = unique(
    $(
      ".breadcrumb-box .nav-item .link, .breadcrumb .item, .bread-crumb a, nav[aria-label*=breadcrumb] a, .nav-item.active h1, .nav-item.active .link"
    )
      .map((_, element) => clean($(element).text()))
      .get()
      .filter(Boolean)
  );

  const specs = {};
  const pushSpec = (section, key, value) => {
    const finalSection = clean(section || "General");
    const finalKey = clean(key);
    const finalValue = clean(value);
    if (!finalKey || !finalValue) return;
    if (!specs[finalSection]) specs[finalSection] = {};
    specs[finalSection][finalKey] = finalValue;
  };

  $("ul.tech-specs-items-description").each((_, list) => {
    const $list = $(list);
    const section =
      clean($list.find(".tech-specs-items-description__title--heading").first().text()) ||
      clean($list.attr("data-target")) ||
      "General";
    $list.find("li.tech-specs-items-description-list").each((__, item) => {
      const $item = $(item);
      pushSpec(
        section,
        $item.find(".tech-specs-items-description__title").first().text(),
        $item.find(".tech-specs-items-description__title-details").first().text()
      );
    });
  });

  $("table").each((_, table) => {
    let section =
      clean($(table).closest("section, .module, .tab-pane, .component").find("h2,h3,h4").first().text()) ||
      "General";
    $(table)
      .find("tr")
      .each((__, row) => {
        const cells = $(row)
          .find("th,td")
          .map((___, cell) => clean($(cell).text()))
          .get()
          .filter(Boolean);
        if (cells.length >= 2) {
          pushSpec(section, cells[0], cells.slice(1).join(" | "));
        } else if (cells.length === 1) {
          section = cells[0];
        }
      });
  });

  $("dl").each((_, dl) => {
    const section =
      clean($(dl).closest("section, .module, .tab-pane, .component").find("h2,h3,h4").first().text()) ||
      "General";
    const dts = $(dl).find("dt").toArray();
    const dds = $(dl).find("dd").toArray();
    for (let i = 0; i < Math.min(dts.length, dds.length); i += 1) {
      pushSpec(section, $(dts[i]).text(), $(dds[i]).text());
    }
  });

  const result = {
    url: normalizeProductUrl(url),
    locale: locale.code,
    title: clean($("title").first().text()),
    productName: "",
    description: clean($('meta[name="description"]').attr("content") || ""),
    lastModified:
      $('meta[name="timestamp"]').attr("content") ||
      $('meta[property="article:modified_time"]').attr("content") ||
      "",
    breadcrumbs,
    headings: $("h1,h2,h3")
      .map((_, element) => clean($(element).text()))
      .get()
      .filter(Boolean),
    links,
    specs,
    dataSheets: unique(
      $("a[href]")
        .map((_, element) => $(element).attr("href"))
        .get()
        .filter((href) => href && /\.pdf($|\?)/i.test(href))
        .map((href) => normalizeUrl(href))
        .filter(Boolean)
    ),
    hasDynamicProductList: $(".product-page-list").length > 0
  };

  result.productName =
    clean($(".product_title_item").first().text()) ||
    breadcrumbs.at(-1) ||
    clean(result.title.split(" - ")[0]) ||
    clean($("h1").first().text()) ||
    clean($(".product-title").first().text()) ||
    clean($(".product-name").first().text()) ||
    clean($(".common-title").first().text()) ||
    result.title;

  result.pathSegments = productSegments(result.url, locale);
  result.pageType = inferPageType(result);
  return result;
}

async function expandDynamicList(page, locale) {
  for (let i = 0; i < 20; i += 1) {
    const clicked = await page.evaluate((texts) => {
      const candidates = [...document.querySelectorAll("button, a, div, span")]
        .filter((node) => node instanceof HTMLElement)
        .filter((node) => {
          const style = window.getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden";
        });

      for (const node of candidates) {
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (texts.includes(text)) {
          node.click();
          return true;
        }
      }
      const explicit = document.querySelector(".view-more-btn");
      if (explicit instanceof HTMLElement) {
        explicit.click();
        return true;
      }
      return false;
    }, locale.viewMoreTexts);

    if (!clicked) {
      break;
    }
    await page.waitForTimeout(locale.code === "cn" ? 1200 : 800);
  }
}

function postProcessLocale(locale, pages) {
  const pageMap = new Map();
  for (const page of pages) {
    if (!page?.url) continue;
    pageMap.set(page.url, page);
  }

  const enrichedPages = [...pageMap.values()]
    .filter((page) => page.pathSegments.length > 0)
    .sort((a, b) => a.url.localeCompare(b.url));

  const models = enrichedPages.filter((page) => page.pageType === "model");
  const directories = enrichedPages.filter((page) => page.pageType !== "model");

  const seriesMap = new Map();
  for (const model of models) {
    const parentUrl = model.parentHint || parentSeriesUrl(model.url);
    const parent = pageMap.get(parentUrl);
    const id = seriesId(locale.code, parentUrl);
    if (!seriesMap.has(id)) {
      seriesMap.set(id, {
        id,
        url: parentUrl,
        name: parent?.productName || parent?.title || humanize(model.pathSegments.at(-2) || "Series"),
        description: parent?.description || "",
        breadcrumbs: parent?.breadcrumbs || model.breadcrumbs.slice(0, -1),
        models: []
      });
    }
    seriesMap.get(id).models.push(model);
  }

  const series = [...seriesMap.values()]
    .map((entry) => {
      entry.models.sort((a, b) => a.productName.localeCompare(b.productName));
      if (MAX_MODELS_PER_SERIES) {
        entry.models = entry.models.slice(0, MAX_MODELS_PER_SERIES);
      }
      entry.differences = buildSeriesDiff(entry.models);
      entry.mindmap = buildSeriesMindmap(locale, entry);
      entry.modelCount = entry.models.length;
      return entry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const tree = buildDirectoryTree(locale, directories, series);
  const overviewMindmap = buildOverviewMindmap(locale, tree);

  return {
    code: locale.code,
    name: locale.name,
    pageCount: enrichedPages.length,
    modelCount: models.length,
    directoryCount: directories.length,
    generatedAt: new Date().toISOString(),
    overviewMindmap,
    tree,
    series
  };
}

function buildSeriesDiff(models) {
  const valuesByKey = new Map();
  for (const model of models) {
    for (const [section, items] of Object.entries(model.specs || {})) {
      for (const [key, value] of Object.entries(items || {})) {
        const compoundKey = `${section} > ${key}`;
        if (!valuesByKey.has(compoundKey)) {
          valuesByKey.set(compoundKey, new Map());
        }
        valuesByKey.get(compoundKey).set(model.productName, value);
      }
    }
  }

  const ranked = [...valuesByKey.entries()]
    .map(([name, valueMap]) => {
      const uniqueValues = unique([...valueMap.values()]);
      return {
        name,
        values: Object.fromEntries(valueMap.entries()),
        uniqueCount: uniqueValues.length,
        coverage: valueMap.size
      };
    })
    .filter((item) => item.uniqueCount > 1)
    .sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (b.uniqueCount !== a.uniqueCount) return b.uniqueCount - a.uniqueCount;
      return a.name.localeCompare(b.name);
    });

  return ranked.slice(0, 16);
}

function buildDirectoryTree(locale, directories, series) {
  const nodes = new Map();
  const rootId = `${locale.code}:root`;
  nodes.set(rootId, {
    id: rootId,
    name: locale.code === "cn" ? "产品中心" : "Products",
    url: LOCALES[locale.code].startUrl,
    type: "root",
    children: []
  });

  for (const page of directories) {
    const segments = page.pathSegments;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const partial = segments.slice(0, depth + 1);
      const url = buildProductUrl(locale.code, partial);
      const id = `${locale.code}:${partial.join("/")}`;
      if (!nodes.has(id)) {
        const currentPage = directories.find((candidate) => candidate.url === url);
        nodes.set(id, {
          id,
          name:
            currentPage?.productName ||
            currentPage?.breadcrumbs.at(-1) ||
            humanize(partial.at(-1)),
          url,
          type: "directory",
          children: []
        });
      }
      const parentId = depth === 0 ? rootId : `${locale.code}:${segments.slice(0, depth).join("/")}`;
      const parent = nodes.get(parentId);
      if (parent && !parent.children.includes(id)) {
        parent.children.push(id);
      }
    }
  }

  for (const entry of series) {
    const parentSegments = productSegments(entry.url, LOCALES[locale.code]).slice(0, -1);
    const parentId = parentSegments.length ? `${locale.code}:${parentSegments.join("/")}` : rootId;
    const id = `${locale.code}:series:${entry.id}`;
    nodes.set(id, {
      id,
      name: entry.name,
      url: entry.url,
      type: "series",
      modelCount: entry.modelCount,
      children: []
    });
    const parent = nodes.get(parentId);
    if (parent && !parent.children.includes(id)) {
      parent.children.push(id);
    }
  }

  return serializeNode(nodes, rootId);
}

function serializeNode(nodes, id) {
  const node = nodes.get(id);
  return {
    ...node,
    children: (node.children || [])
      .map((childId) => serializeNode(nodes, childId))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

function buildOverviewMindmap(locale, tree) {
  const lines = ["mindmap", `  root((${escapeMermaid(locale.name)}))`];
  const visit = (node, depth) => {
    const prefix = "  ".repeat(depth + 1);
    const suffix = node.type === "series" && node.modelCount ? ` (${node.modelCount})` : "";
    lines.push(`${prefix}${escapeMermaid(node.name + suffix)}`);
    for (const child of node.children || []) {
      visit(child, depth + 1);
    }
  };
  for (const child of tree.children || []) {
    visit(child, 1);
  }
  return lines.join("\n");
}

function buildSeriesMindmap(locale, series) {
  const lines = [
    "mindmap",
    `  root((${escapeMermaid(series.name)}))`,
    `    ${escapeMermaid(locale.code === "cn" ? "型号差异" : "Model Differences")}`
  ];
  for (const difference of series.differences.slice(0, 8)) {
    lines.push(`      ${escapeMermaid(difference.name)}`);
  }
  lines.push(`    ${escapeMermaid(locale.code === "cn" ? "型号列表" : "Models")}`);
  for (const model of series.models) {
    lines.push(`      ${escapeMermaid(model.productName)}`);
  }
  return lines.join("\n");
}

function renderHtml(bundle) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hikvision 产品思维导图</title>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    const data = ${JSON.stringify(bundle)};
    const state = { locale: Object.keys(data.locales)[0], selectedSeries: null };

    const localeLabel = document.getElementById('locale-label');
    const localeButtons = document.getElementById('locale-buttons');
    const seriesList = document.getElementById('series-list');
    const diffTable = document.getElementById('diff-table');
    const mermaidHost = document.getElementById('mermaid-host');
    const stats = document.getElementById('stats');

    function render() {
      const locale = data.locales[state.locale];
      localeLabel.textContent = locale.name;
      stats.textContent = 'Pages: ' + locale.pageCount + ' | Models: ' + locale.modelCount + ' | Series: ' + locale.series.length;
      localeButtons.innerHTML = Object.values(data.locales).map(item => '<button class="' + (item.code === state.locale ? 'active' : '') + '" data-locale="' + item.code + '">' + item.name + '</button>').join('');
      seriesList.innerHTML = locale.series.map(item => '<button class="series-btn ' + (state.selectedSeries === item.id ? 'active' : '') + '" data-series="' + item.id + '">' + item.name + ' (' + item.modelCount + ')</button>').join('');
      const series = locale.series.find(item => item.id === state.selectedSeries) || locale.series[0];
      state.selectedSeries = series ? series.id : null;
      const mindmap = series ? series.mindmap : locale.overviewMindmap;
      mermaidHost.innerHTML = '<pre class="mermaid">' + mindmap.replace(/</g, '&lt;') + '</pre>';
      mermaid.run({ nodes: [mermaidHost.querySelector('.mermaid')] });

      if (!series) {
        diffTable.innerHTML = '<p>No series found.</p>';
        return;
      }
      const headers = series.models.map(model => '<th>' + model.productName + '</th>').join('');
      const rows = series.differences.map(item => '<tr><td>' + item.name + '</td>' + series.models.map(model => '<td>' + (item.values[model.productName] || '') + '</td>').join('') + '</tr>').join('');
      diffTable.innerHTML = '<table><thead><tr><th>${"字段 / Field"}</th>' + headers + '</tr></thead><tbody>' + rows + '</tbody></table>';
    }

    localeButtons.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-locale]');
      if (!button) return;
      state.locale = button.dataset.locale;
      state.selectedSeries = null;
      render();
    });

    seriesList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-series]');
      if (!button) return;
      state.selectedSeries = button.dataset.series;
      render();
    });

    render();
  </script>
  <style>
    :root {
      --bg: #f5f0e8;
      --panel: #fffaf4;
      --text: #1d2a33;
      --muted: #5a6a73;
      --line: #dccfbe;
      --brand: #c6362e;
      --brand-soft: #f3d8d4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, #fff4df 0, transparent 28%),
        radial-gradient(circle at top right, #f8ddd3 0, transparent 24%),
        linear-gradient(180deg, #f6efe5 0%, #efe7db 100%);
    }
    .shell {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 20px;
    }
    .panel {
      background: rgba(255,250,244,.9);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 20px;
      backdrop-filter: blur(8px);
      box-shadow: 0 12px 40px rgba(82, 52, 32, .08);
    }
    h1, h2, h3, p { margin-top: 0; }
    #locale-buttons, #series-list { display: flex; flex-wrap: wrap; gap: 10px; }
    button {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: white;
      padding: 8px 14px;
      cursor: pointer;
    }
    button.active {
      background: var(--brand);
      color: white;
      border-color: var(--brand);
    }
    .series-btn {
      width: 100%;
      text-align: left;
      border-radius: 14px;
    }
    #diff-table { overflow: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      background: white;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 10px;
      text-align: left;
      vertical-align: top;
    }
    .stats { color: var(--muted); }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel">
      <h1>Hikvision 产品地图</h1>
      <p class="stats" id="stats"></p>
      <h3>语言</h3>
      <div id="locale-buttons"></div>
      <h3>当前语言</h3>
      <p id="locale-label"></p>
      <h3>系列</h3>
      <div id="series-list"></div>
    </aside>
    <main class="panel">
      <h2>思维导图</h2>
      <div id="mermaid-host"></div>
      <h2>同系列型号差异</h2>
      <div id="diff-table"></div>
    </main>
  </div>
</body>
</html>`;
}

function inferPageType(page) {
  const haystack = `${page.url} ${page.productName || ""} ${page.title || ""}`;
  if (page.url.includes("/pdplist/")) return "model";
  if (/\bDS[-\s]/i.test(haystack)) return "model";
  if ((page.dataSheets || []).length > 0 && Object.keys(page.specs || {}).length > 0) return "model";
  if (page.pathSegments.length === 0) return "root";
  return "directory";
}

function productSegments(url, locale) {
  const pathname = new URL(url).pathname;
  const parts = pathname.split("/").filter(Boolean);
  const prefixParts = locale.prefix.split("/").filter(Boolean);
  if (parts[0] === locale.code && parts[1] === "products") {
    return parts.slice(2);
  }
  return parts.slice(prefixParts.length);
}

function buildProductUrl(localeCode, segments) {
  return `https://www.hikvision.com/${localeCode}/products/${segments.join("/")}/`;
}

function parentSeriesUrl(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const trimmed = segments.slice(0, -1);
  parsed.pathname = `/${trimmed.join("/")}/`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function seriesId(localeCode, url) {
  return normalizeIdentifier(`${localeCode}-${productSegments(url, LOCALES[localeCode]).join("-")}`);
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function normalizeProductUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    if (!parsed.pathname.endsWith("/")) {
      parsed.pathname += "/";
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function escapeMermaid(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeIdentifier(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function findExecutable() {
  for (const candidate of EDGE_PATHS) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Could not find Microsoft Edge. Set PLAYWRIGHT_EXECUTABLE_PATH if needed.");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function numericArg(value) {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
