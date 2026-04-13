import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const SITE_DIR = path.join(ROOT, "site");
const DATA_DIR = path.join(ROOT, "data");
const CACHE_DIR = path.join(DATA_DIR, "cache");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const CACHE_FILE = path.join(CACHE_DIR, "spec-cache.json");
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, "latest.json");

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const SERIES_PER_LOCALE = Number(args["series-per-locale"] || 8);
const MODELS_PER_SERIES = Number(args["models-per-series"] || 25);
const MAX_FETCH = Number(args["max-fetch"] || 300);
const CONCURRENCY = Number(args.concurrency || 6);
const BROWSER_PATHS = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
].filter(Boolean);

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(SNAPSHOT_DIR, { recursive: true });

const catalog = JSON.parse(await readFile(path.join(SITE_DIR, "catalog.json"), "utf8"));
const previousCache = await readJson(CACHE_FILE, { items: {} });
const previousSnapshot = await readJson(SNAPSHOT_FILE, null);

const targetModels = [];
const cnSeriesSeed = [];
for (const locale of Object.values(catalog.locales)) {
  for (const series of locale.series.slice(0, SERIES_PER_LOCALE)) {
    if (locale.code === "cn") {
      cnSeriesSeed.push({
        locale: locale.code,
        seriesKey: series.key,
        seriesName: series.name,
        url: normalizeChineseSeriesUrl(series)
      });
      continue;
    }
    for (const model of series.models.slice(0, MODELS_PER_SERIES)) {
      const entry = locale.entries.find((item) => item.url === model.url);
      if (entry) {
        targetModels.push({
          locale: locale.code,
          seriesKey: series.key,
          seriesName: series.name,
          modelName: model.name,
          url: model.url,
          lastmod: entry.lastmod || ""
        });
      }
    }
  }
}

if (cnSeriesSeed.length > 0) {
  try {
    const discovered = await discoverChinesePdplistModels(cnSeriesSeed, MODELS_PER_SERIES);
    targetModels.push(...discovered);
  } catch (error) {
    console.warn(`[cn-discovery] ${error instanceof Error ? error.message : String(error)}`);
  }
}

const dedupedTargets = [...new Map(targetModels.map((item) => [item.url, item])).values()];
const staleTargets = dedupedTargets.filter((item) => {
  const cached = previousCache.items[item.url];
  return !cached || cached.lastmod !== item.lastmod || !cached.specHash;
});
const targetsToFetch = staleTargets.slice(0, MAX_FETCH);

console.log(`Target models: ${dedupedTargets.length}, fetch now: ${targetsToFetch.length}`);

const updatedItems = { ...previousCache.items };
await runPool(targetsToFetch, CONCURRENCY, async (target, index) => {
  console.log(`[fetch] ${index + 1}/${targetsToFetch.length} ${target.url}`);
  const parsed = await scrapeSpecPage(target);
  updatedItems[target.url] = parsed;
});

const diffLocales = {};
for (const locale of Object.values(catalog.locales)) {
  diffLocales[locale.code] = buildLocaleDiff(locale, updatedItems);
}

const currentSnapshot = buildSnapshot(catalog, updatedItems, diffLocales);
const changes = compareSnapshots(previousSnapshot, currentSnapshot);
const diffPayload = {
  generatedAt: new Date().toISOString(),
  fetchSummary: {
    targets: dedupedTargets.length,
    fetchedThisRun: targetsToFetch.length,
    cached: Object.keys(updatedItems).length
  },
  changes,
  locales: diffLocales
};

await writeFile(CACHE_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), items: updatedItems }), "utf8");
await writeFile(SNAPSHOT_FILE, JSON.stringify(currentSnapshot), "utf8");
await writeFile(path.join(SITE_DIR, "diff-data.json"), JSON.stringify(diffPayload), "utf8");

function buildLocaleDiff(locale, cacheItems) {
  const cachedBySeries = Object.values(cacheItems)
    .filter((item) => item?.locale === locale.code && item.valid !== false)
    .reduce((acc, item) => {
      if (!acc[item.seriesKey]) acc[item.seriesKey] = [];
      acc[item.seriesKey].push(item);
      return acc;
    }, {});

  const series = locale.series.slice(0, SERIES_PER_LOCALE).map((series) => {
    const cachedModels = locale.code === "cn"
      ? (cachedBySeries[series.key] || []).slice(0, MODELS_PER_SERIES)
      : series.models
          .slice(0, MODELS_PER_SERIES)
          .map((model) => cacheItems[model.url])
          .filter((item) => item && item.valid !== false);
    return {
      key: series.key,
      name: series.name,
      url: series.url,
      modelCount: series.modelCount,
      specCoverage: cachedModels.length,
      models: cachedModels.map((item) => ({
        name: item.productName,
        url: item.url,
        lastmod: item.lastmod,
        specSections: Object.keys(item.specs || {}).length
      })),
      differences: buildSeriesDifferences(cachedModels).slice(0, 40)
    };
  });

  return {
    code: locale.code,
    topSeries: series
  };
}

function buildSeriesDifferences(models) {
  const valuesByField = new Map();
  for (const model of models) {
    for (const [section, items] of Object.entries(model.specs || {})) {
      for (const [key, value] of Object.entries(items || {})) {
        const field = `${section} > ${key}`;
        if (!valuesByField.has(field)) {
          valuesByField.set(field, new Map());
        }
        valuesByField.get(field).set(model.productName, value);
      }
    }
  }
  return [...valuesByField.entries()]
    .map(([field, valueMap]) => ({
      field,
      coverage: valueMap.size,
      uniqueCount: new Set(valueMap.values()).size,
      values: Object.fromEntries(valueMap.entries())
    }))
    .filter((item) => item.uniqueCount > 1)
    .sort((a, b) => b.coverage - a.coverage || b.uniqueCount - a.uniqueCount || a.field.localeCompare(b.field));
}

function buildSnapshot(catalogData, cacheItems, diffLocales) {
  const urls = {};
  for (const [localeCode, locale] of Object.entries(catalogData.locales)) {
    urls[localeCode] = locale.entries.map((entry) => entry.url).sort();
  }
  const specHashes = Object.fromEntries(
    Object.entries(cacheItems).map(([url, item]) => [url, item.specHash])
  );
  const coverage = Object.fromEntries(
    Object.entries(diffLocales).map(([localeCode, locale]) => [
      localeCode,
      locale.topSeries.map((series) => ({
        key: series.key,
        name: series.name,
        specCoverage: series.specCoverage,
        diffFields: series.differences.length
      }))
    ])
  );
  return {
    generatedAt: new Date().toISOString(),
    urls,
    specHashes,
    coverage
  };
}

function compareSnapshots(previous, current) {
  if (!previous) {
    return {
      initialized: true,
      addedUrls: sum(Object.values(current.urls).map((items) => items.length)),
      removedUrls: 0,
      changedSpecs: Object.keys(current.specHashes).length
    };
  }

  let addedUrls = 0;
  let removedUrls = 0;
  for (const localeCode of Object.keys(current.urls)) {
    const prev = new Set(previous.urls?.[localeCode] || []);
    const next = new Set(current.urls?.[localeCode] || []);
    for (const url of next) if (!prev.has(url)) addedUrls += 1;
    for (const url of prev) if (!next.has(url)) removedUrls += 1;
  }

  let changedSpecs = 0;
  for (const [url, hash] of Object.entries(current.specHashes)) {
    if (previous.specHashes?.[url] && previous.specHashes[url] !== hash) {
      changedSpecs += 1;
    }
  }

  return { initialized: false, addedUrls, removedUrls, changedSpecs };
}

async function scrapeSpecPage(target) {
  const response = await fetch(target.url, {
    headers: { "user-agent": "Mozilla/5.0" }
  });
  const html = await decodeHtml(response);
  const $ = cheerio.load(html);
  const clean = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\u00a0/g, " ")
      .trim();

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

  $(".tech-specs-accordion-desc-list").each((_, list) => {
    const $list = $(list);
    const section =
      clean($list.attr("data-target")) ||
      clean($list.find(".item-header").first().text()) ||
      "General";
    $list.find(".tech-specs-accordion-desc-item").each((__, item) => {
      const $item = $(item);
      pushSpec(
        section,
        $item.find(".item-title").first().text(),
        $item.find(".item-desc").first().text()
      );
    });
  });

  const productName =
    clean($(".product_title_item").first().text()) ||
    clean($("h1").first().text()) ||
    clean($("title").first().text().split(" - ")[0]);
  const pageTitle = clean($("title").first().text());
  const valid = !/^404\b/i.test(pageTitle) && Object.keys(specs).length > 0;

  return {
    locale: target.locale,
    seriesKey: target.seriesKey,
    seriesName: target.seriesName,
    url: target.url,
    lastmod: target.lastmod,
    productName,
    specs,
    specHash: hashObject(specs),
    valid
  };
}

async function decodeHtml(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "";
  const headerCharset = /charset=([^;]+)/i.exec(contentType)?.[1];
  const sniff = buffer.toString("ascii", 0, Math.min(buffer.length, 2048));
  const metaCharset =
    /<meta[^>]+charset=["']?\s*([^"'\s/>]+)/i.exec(sniff)?.[1] ||
    /<meta[^>]+content=["'][^"']*charset=([^"';\s]+)/i.exec(sniff)?.[1];
  const charset = normalizeCharset(metaCharset || headerCharset);
  return new TextDecoder(charset).decode(buffer);
}

function normalizeCharset(charset) {
  const value = String(charset || "utf-8").trim().toLowerCase();
  if (value === "gb2312" || value === "gbk" || value === "gb18030") return "gbk";
  if (value === "utf8") return "utf-8";
  return value || "utf-8";
}

async function discoverChinesePdplistModels(seriesSeed, maxModelsPerSeries) {
  const apiDiscovered = await discoverChineseModelsViaApi(seriesSeed, maxModelsPerSeries);
  const coveredSeries = new Set(apiDiscovered.map((item) => item.seriesKey));
  const missingSeries = seriesSeed.filter((series) => !coveredSeries.has(series.seriesKey));
  if (missingSeries.length === 0) {
    return apiDiscovered;
  }

  const fallbackDiscovered = await discoverChineseModelsViaBrowser(missingSeries, maxModelsPerSeries);
  return [...apiDiscovered, ...fallbackDiscovered];
}

async function discoverChineseModelsViaApi(seriesSeed, maxModelsPerSeries) {
  const discovered = [];
  for (const series of seriesSeed) {
    try {
      const html = await fetch(series.url, {
        headers: { "user-agent": "Mozilla/5.0" }
      }).then((response) => response.text());
      const $ = cheerio.load(html);
      const list = $(".product-page-list[data-url][data-value]").first();
      const endpoint = list.attr("data-url");
      const directory = list.attr("data-value");
      if (!endpoint || !directory) {
        continue;
      }

      const apiUrl = new URL(endpoint, series.url).href;
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": "Mozilla/5.0"
        },
        body: new URLSearchParams({ directory }).toString()
      });
      const payload = await response.json();
      const productList = payload?.data?.productList || [];
      for (const product of productList.slice(0, maxModelsPerSeries)) {
        if (!product?.pagePath) continue;
        discovered.push({
          locale: "cn",
          seriesKey: series.seriesKey,
          seriesName: series.seriesName,
          modelName: product.productModel || product.modelName || "",
          url: new URL(product.pagePath, series.url).href,
          lastmod: ""
        });
      }
    } catch {}
  }
  return dedupeModels(discovered);
}

async function discoverChineseModelsViaBrowser(seriesSeed, maxModelsPerSeries) {
  const executablePath = await findExecutable();
  const browser = executablePath
    ? await chromium.launch({ headless: true, executablePath })
    : await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  });

  const discovered = [];
  try {
    for (const series of seriesSeed) {
      const page = await context.newPage();
      try {
        await page.goto(series.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(3500);
        const urls = await page.evaluate((limit) => {
          const found = [...document.querySelectorAll("a[href],a[data-href]")]
            .map((anchor) => anchor.getAttribute("href") || anchor.getAttribute("data-href"))
            .filter(Boolean)
            .filter((value) => value.includes("/cn/products/pdplist/"))
            .map((value) => new URL(value, location.origin).href.replace(/[#?].*$/, ""))
            .map((value) => value.endsWith("/") ? value : value + "/");
          return [...new Set(found)].slice(0, limit);
        }, maxModelsPerSeries);

        for (const url of urls) {
          discovered.push({
            locale: "cn",
            seriesKey: series.seriesKey,
            seriesName: series.seriesName,
            modelName: "",
            url,
            lastmod: ""
          });
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return dedupeModels(discovered);
}

function normalizeChineseSeriesUrl(series) {
  const path = series.path.map((segment, index) => (index < 2 ? segment.toLowerCase() : segment)).join("/");
  return `https://www.hikvision.com/cn/products/${path}/`;
}

function dedupeModels(items) {
  return [...new Map(items.map((item) => [item.url, item])).values()];
}

async function findExecutable() {
  for (const candidate of BROWSER_PATHS) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

function hashObject(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return fallback;
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
