import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as cheerio from "cheerio";

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

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(SNAPSHOT_DIR, { recursive: true });

const catalog = JSON.parse(await readFile(path.join(SITE_DIR, "catalog.json"), "utf8"));
const previousCache = await readJson(CACHE_FILE, { items: {} });
const previousSnapshot = await readJson(SNAPSHOT_FILE, null);

const targetModels = [];
for (const locale of Object.values(catalog.locales)) {
  for (const series of locale.series.slice(0, SERIES_PER_LOCALE)) {
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
  const series = locale.series.slice(0, SERIES_PER_LOCALE).map((series) => {
    const cachedModels = series.models
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
  const html = await fetch(target.url, {
    headers: { "user-agent": "Mozilla/5.0" }
  }).then((response) => response.text());
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
