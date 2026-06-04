import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";

const ROOT = process.cwd();
const SITE_DIR = path.join(ROOT, "site");
const CACHE_DIR = path.join(ROOT, "data", "cache");
const CATALOG_FILE = path.join(SITE_DIR, "catalog.json");
const DIFF_FILE = path.join(SITE_DIR, "diff-data.json");
const ASSET_CACHE_FILE = path.join(CACHE_DIR, "product-assets.json");
const OUT_FILE = path.join(SITE_DIR, "selector-data.json");

const catalog = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
const diffData = await readJson(DIFF_FILE, { locales: {} });
const assetCache = await readJson(ASSET_CACHE_FILE, {});
const REFRESH_ASSETS = process.argv.includes("--refresh-assets") || process.env.REFRESH_PRODUCT_ASSETS === "1";

const CATEGORY_RULES = [
  { id: "camera", terms: ["network-cameras", "fixed-camera", "turbo-hd-cameras", "analog-camera", "bullet", "dome", "turret", "hilook-ip-products/network-cameras"] },
  { id: "ptz", terms: ["ptz", "ptz-camera", "speed-dome", "positioning-system", "panovu"] },
  { id: "thermal", terms: ["thermal", "thermography"] },
  { id: "recorder", terms: ["network-video-recorders", "digital-hard-disk-recorder", "video-recorder", "nvr", "dvr", "xvr", "edvr"] },
  { id: "storage", terms: ["storage", "san", "cvr", "data-storage"] },
  { id: "switch", terms: ["switch", "router", "wireless-bridge", "wireless-access-point", "optical", "transmission", "network-product"] },
  { id: "access", terms: ["access-control", "turnstile", "card-reader", "face-recognition", "fingerprint", "electric-lock", "door"] },
  { id: "intercom", terms: ["video-intercom", "building-intercom", "door-station", "indoor-station", "sip-phone"] },
  { id: "parking", terms: ["parking", "entrance-and-exit", "barrier", "anpr", "traffic-cameras", "its-products"] },
  { id: "alarm", terms: ["alarm", "intrusion", "detector", "security-control"] },
  { id: "fire", terms: ["fire", "fire-protection", "smoke", "gas-detector", "emergency-lighting"] },
  { id: "display", terms: ["display", "monitor", "lcd", "led", "video-wall"] },
  { id: "audio", terms: ["audio", "speaker", "microphone", "amplifier", "public-address"] },
  { id: "software", terms: ["software", "hikcentral", "platform"] },
  { id: "server", terms: ["server", "data-center", "ai-server", "cloud-computing"] },
  { id: "accessory", terms: ["accessories", "bracket", "power-supply", "junction", "housing"] }
];

const CATEGORY_LABELS = {
  camera: { cn: "固定/枪球摄像机", en: "Fixed Cameras" },
  ptz: { cn: "云台/球机", en: "PTZ Cameras" },
  thermal: { cn: "热成像", en: "Thermal" },
  recorder: { cn: "录像机", en: "Recorders" },
  storage: { cn: "存储", en: "Storage" },
  switch: { cn: "交换/网络", en: "Network" },
  access: { cn: "门禁/通道", en: "Access Control" },
  intercom: { cn: "可视对讲", en: "Video Intercom" },
  parking: { cn: "停车/出入口", en: "Parking" },
  alarm: { cn: "报警/探测", en: "Alarm" },
  fire: { cn: "消防", en: "Fire" },
  display: { cn: "显示/拼控", en: "Display" },
  audio: { cn: "音频广播", en: "Audio" },
  software: { cn: "平台软件", en: "Software" },
  server: { cn: "服务器", en: "Server" },
  accessory: { cn: "配件", en: "Accessories" }
};

const SCENARIOS = [
  {
    id: "video",
    icon: "video",
    labels: { cn: "视频监控", en: "Video Surveillance" },
    defaults: { cameras: 32, ptz: 2, recorders: 1, switches: 2, displays: 1, retentionDays: 30 },
    roles: [
      { key: "camera", category: "camera", labels: { cn: "前端摄像机", en: "Cameras" }, qty: "cameras" },
      { key: "ptz", category: "ptz", labels: { cn: "重点位球机", en: "PTZ" }, qty: "ptz", optional: true },
      { key: "switch", category: "switch", labels: { cn: "PoE/汇聚交换", en: "PoE/Core Switch" }, qty: "switches" },
      { key: "recorder", category: "recorder", labels: { cn: "录像存储", en: "Recorder" }, qty: "recorders" },
      { key: "display", category: "display", labels: { cn: "显示终端", en: "Display" }, qty: "displays", optional: true },
      { key: "software", category: "software", labels: { cn: "管理平台", en: "Management Platform" }, qty: "recorders", optional: true }
    ],
    topology: {
      nodes: [
        { id: "client", labels: { cn: "客户端/手机", en: "Client/App" }, shape: "round" },
        { id: "platform", role: "software", labels: { cn: "管理平台", en: "Platform" } },
        { id: "core", role: "switch", labels: { cn: "核心/汇聚交换", en: "Core Switch" } },
        { id: "poe", role: "switch", labels: { cn: "PoE接入交换", en: "PoE Switch" } },
        { id: "camera", role: "camera", metric: "cameras", labels: { cn: "固定摄像机", en: "Fixed Cameras" } },
        { id: "ptz", role: "ptz", metric: "ptz", labels: { cn: "球机/云台", en: "PTZ Cameras" }, optionalMetric: true },
        { id: "recorder", role: "recorder", metric: "recorders", labels: { cn: "NVR/录像机", en: "NVR/Recorder" } },
        { id: "storage", role: "storage", metric: "retentionDays", metricSuffix: { cn: "天", en: " days" }, labels: { cn: "存储周期", en: "Retention" }, shape: "database" },
        { id: "display", role: "display", metric: "displays", labels: { cn: "监视器/拼控", en: "Display" }, optionalMetric: true }
      ],
      edges: [["client", "platform"], ["platform", "core"], ["core", "poe"], ["poe", "camera"], ["poe", "ptz"], ["core", "recorder"], ["recorder", "storage"], ["recorder", "display"]]
    }
  },
  {
    id: "access",
    icon: "door",
    labels: { cn: "门禁通道", en: "Access Control" },
    defaults: { doors: 8, readers: 16, controllers: 2, switches: 1, clients: 1 },
    roles: [
      { key: "terminal", category: "access", labels: { cn: "门禁终端/读卡器", en: "Terminal/Reader" }, qty: "readers" },
      { key: "controller", category: "access", labels: { cn: "门禁控制器", en: "Controller" }, qty: "controllers" },
      { key: "lock", category: "access", labels: { cn: "电锁/门磁", en: "Lock/Contact" }, qty: "doors", optional: true },
      { key: "switch", category: "switch", labels: { cn: "网络交换", en: "Network" }, qty: "switches" },
      { key: "software", category: "software", labels: { cn: "门禁平台", en: "Access Platform" }, qty: "clients", optional: true }
    ],
    topology: {
      nodes: [
        { id: "person", labels: { cn: "人员/访客", en: "People" }, shape: "round" },
        { id: "terminal", role: "terminal", metric: "readers", labels: { cn: "读卡/人脸终端", en: "Readers/Terminals" } },
        { id: "controller", role: "controller", metric: "controllers", labels: { cn: "门禁控制器", en: "Controller" } },
        { id: "door", role: "lock", metric: "doors", labels: { cn: "门锁/门磁", en: "Door Hardware" } },
        { id: "switch", role: "switch", metric: "switches", labels: { cn: "接入网络", en: "Network" } },
        { id: "platform", role: "software", labels: { cn: "门禁平台", en: "Platform" } },
        { id: "client", labels: { cn: "管理客户端", en: "Client" }, shape: "round" }
      ],
      edges: [["person", "terminal"], ["terminal", "controller"], ["controller", "door"], ["controller", "switch"], ["switch", "platform"], ["platform", "client"]]
    }
  },
  {
    id: "parking",
    icon: "car",
    labels: { cn: "停车出入口", en: "Parking Entrance" },
    defaults: { lanes: 4, cameras: 4, barriers: 4, displays: 2, switches: 1, clients: 1 },
    roles: [
      { key: "anpr", category: "parking", labels: { cn: "车牌识别/抓拍", en: "ANPR Camera" }, qty: "cameras" },
      { key: "barrier", category: "parking", labels: { cn: "道闸/控制终端", en: "Barrier/Controller" }, qty: "barriers" },
      { key: "display", category: "display", labels: { cn: "余位屏/信息屏", en: "LED/Display" }, qty: "displays", optional: true },
      { key: "switch", category: "switch", labels: { cn: "网络交换", en: "Network" }, qty: "switches" },
      { key: "software", category: "software", labels: { cn: "停车管理平台", en: "Parking Platform" }, qty: "clients", optional: true }
    ],
    topology: {
      nodes: [
        { id: "vehicle", labels: { cn: "车辆", en: "Vehicle" }, shape: "round" },
        { id: "anpr", role: "anpr", metric: "cameras", labels: { cn: "车牌识别相机", en: "ANPR Cameras" } },
        { id: "barrier", role: "barrier", metric: "barriers", labels: { cn: "道闸/控制机", en: "Barrier" } },
        { id: "switch", role: "switch", metric: "switches", labels: { cn: "网络交换", en: "Network" } },
        { id: "platform", role: "software", labels: { cn: "停车平台", en: "Parking Platform" } },
        { id: "display", role: "display", metric: "displays", labels: { cn: "LED/余位屏", en: "LED Display" }, optionalMetric: true },
        { id: "client", labels: { cn: "岗亭/中心客户端", en: "Client" }, shape: "round" }
      ],
      edges: [["vehicle", "anpr"], ["anpr", "barrier"], ["barrier", "switch"], ["switch", "platform"], ["platform", "display"], ["platform", "client"]]
    }
  },
  {
    id: "intercom",
    icon: "intercom",
    labels: { cn: "可视对讲", en: "Video Intercom" },
    defaults: { entrances: 4, indoorStations: 48, switches: 2, clients: 1 },
    roles: [
      { key: "doorStation", category: "intercom", labels: { cn: "门口机", en: "Door Station" }, qty: "entrances" },
      { key: "indoorStation", category: "intercom", labels: { cn: "室内机", en: "Indoor Station" }, qty: "indoorStations" },
      { key: "switch", category: "switch", labels: { cn: "PoE/网络", en: "PoE/Network" }, qty: "switches" },
      { key: "recorder", category: "recorder", labels: { cn: "录像/存储", en: "Recorder" }, qty: "clients", optional: true },
      { key: "software", category: "software", labels: { cn: "管理平台", en: "Platform" }, qty: "clients", optional: true }
    ],
    topology: {
      nodes: [
        { id: "visitor", labels: { cn: "访客", en: "Visitor" }, shape: "round" },
        { id: "doorStation", role: "doorStation", metric: "entrances", labels: { cn: "门口机", en: "Door Station" } },
        { id: "switch", role: "switch", metric: "switches", labels: { cn: "PoE/网络", en: "Network" } },
        { id: "indoor", role: "indoorStation", metric: "indoorStations", labels: { cn: "室内机", en: "Indoor Station" } },
        { id: "platform", role: "software", labels: { cn: "管理平台", en: "Platform" } },
        { id: "recorder", role: "recorder", labels: { cn: "录像/存储", en: "Recorder" } },
        { id: "app", labels: { cn: "手机/客户端", en: "App/Client" }, shape: "round" }
      ],
      edges: [["visitor", "doorStation"], ["doorStation", "switch"], ["switch", "indoor"], ["switch", "platform"], ["platform", "recorder"], ["platform", "app"]]
    }
  },
  {
    id: "alarm-fire",
    icon: "shield",
    labels: { cn: "报警消防", en: "Alarm And Fire" },
    defaults: { detectors: 64, panels: 2, sirens: 8, switches: 1, clients: 1 },
    roles: [
      { key: "detector", category: "alarm", labels: { cn: "入侵/探测器", en: "Alarm Detector" }, qty: "detectors" },
      { key: "fire", category: "fire", labels: { cn: "消防探测/主机", en: "Fire Device" }, qty: "panels" },
      { key: "panel", category: "alarm", labels: { cn: "报警主机", en: "Alarm Panel" }, qty: "panels" },
      { key: "audio", category: "audio", labels: { cn: "声光/广播", en: "Siren/Audio" }, qty: "sirens", optional: true },
      { key: "software", category: "software", labels: { cn: "联动平台", en: "Platform" }, qty: "clients", optional: true }
    ],
    topology: {
      nodes: [
        { id: "detector", role: "detector", metric: "detectors", labels: { cn: "入侵探测器", en: "Detectors" } },
        { id: "fire", role: "fire", metric: "panels", labels: { cn: "消防探测", en: "Fire Devices" } },
        { id: "panel", role: "panel", metric: "panels", labels: { cn: "报警/消防主机", en: "Panel" } },
        { id: "audio", role: "audio", metric: "sirens", labels: { cn: "声光/广播联动", en: "Siren/Audio" }, optionalMetric: true },
        { id: "platform", role: "software", labels: { cn: "联动平台", en: "Platform" } },
        { id: "client", labels: { cn: "值班室/客户端", en: "Client" }, shape: "round" }
      ],
      edges: [["detector", "panel"], ["fire", "panel"], ["panel", "audio"], ["panel", "platform"], ["platform", "client"]]
    }
  }
];

const families = {};
for (const [localeCode, locale] of Object.entries(catalog.locales)) {
  const diffBySeries = new Map((diffData.locales?.[localeCode]?.topSeries || []).map((series) => [series.key, series]));
  const byCategory = Object.fromEntries(CATEGORY_RULES.map((rule) => [rule.id, []]));

  for (const series of locale.series) {
    const categories = classify(series);
    const diff = diffBySeries.get(series.key);
    const item = {
      id: slug(`${localeCode}-${series.key}`),
      key: series.key,
      name: cleanName(series.name),
      path: series.path,
      pathText: series.path.join(" / "),
      url: series.url,
      modelCount: series.modelCount,
      models: series.models.slice(0, 60).map((model) => ({ name: cleanModelName(model.name, model.url), url: model.url })),
      diffFields: diff?.differences?.length || 0,
      comparedModels: diff?.specCoverage || 0,
      differenceSummary: (diff?.differences || []).slice(0, 6).map((difference) => ({
        field: simplifyField(difference.field),
        values: [...new Set(Object.values(difference.values || {}).filter(Boolean).map((value) => String(value).trim()))].slice(0, 3)
      }))
    };

    for (const category of categories) {
      byCategory[category].push(item);
    }
  }

  for (const category of Object.keys(byCategory)) {
    byCategory[category] = dedupe(byCategory[category])
      .sort((left, right) => right.diffFields - left.diffFields || right.modelCount - left.modelCount || left.name.localeCompare(right.name))
      .slice(0, 160);
  }
  families[localeCode] = byCategory;
}

await hydrateProductAssets(families);
await mkdir(CACHE_DIR, { recursive: true });
await writeFile(ASSET_CACHE_FILE, JSON.stringify(assetCache, null, 2), "utf8");

const payload = {
  generatedAt: new Date().toISOString(),
  source: {
    catalog: "Hikvision public product sitemap",
    reference: "https://hitools.hikvision.com/HiToolsDesigner/#/select/productSelection?site=en"
  },
  categoryLabels: CATEGORY_LABELS,
  scenarios: SCENARIOS,
  families
};

await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");

async function hydrateProductAssets(familyMap) {
  const byItem = new Map();
  for (const localeFamilies of Object.values(familyMap)) {
    for (const items of Object.values(localeFamilies)) {
      for (const item of items) {
        if (!byItem.has(item.id)) byItem.set(item.id, item);
      }
    }
  }

  const entries = [...byItem.values()];
  let cursor = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (cursor < entries.length) {
      const item = entries[cursor++];
      const asset = await getBestProductAsset(item);
      if (asset.imageUrl) item.imageUrl = asset.imageUrl;
      if (asset.description) item.description = asset.description;
      if (asset.detailTitle) item.detailTitle = asset.detailTitle;
      if (asset.sourceModelUrl) item.sourceModelUrl = asset.sourceModelUrl;
    }
  });
  await Promise.all(workers);
}

async function getBestProductAsset(item) {
  const urls = [
    ...(item.models || []).slice(0, 8).map((model) => model.url),
    item.url
  ].filter(Boolean);

  let fallback = null;
  for (const url of [...new Set(urls)]) {
    const asset = await getProductAsset(url);
    const withSource = { ...asset, sourceModelUrl: url };
    if (!fallback && (asset.description || asset.detailTitle)) fallback = withSource;
    if (asset.imageUrl) return withSource;
  }
  return fallback || { imageUrl: "", description: "", detailTitle: "", sourceModelUrl: urls[0] || item.url };
}

async function getProductAsset(url) {
  const cached = assetCache[url];
  if (cached?.imageUrl || cached?.description) return cached;
  if (!REFRESH_ASSETS) return cached || { imageUrl: "", description: "", detailTitle: "" };

  const empty = { imageUrl: "", description: "", detailTitle: "", fetchedAt: new Date().toISOString() };
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 Hikvision product selector builder"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      assetCache[url] = { ...empty, status: response.status };
      return assetCache[url];
    }
    const html = await response.text();
    assetCache[url] = extractProductAsset(html, url);
    return assetCache[url];
  } catch (error) {
    assetCache[url] = { ...empty, error: error.message };
    return assetCache[url];
  }
}

function extractProductAsset(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidates = [];
  $("link[as='image'], link[data-type='image'], meta[property='og:image'], meta[name='twitter:image']").each((_, element) => {
    const value = $(element).attr("href") || $(element).attr("content");
    if (value) candidates.push(value);
  });
  for (const match of html.matchAll(/https?:\/\/assets\.hikvision\.com\/[^"'<>\s]+?\.(?:png|jpg|jpeg|webp)(?:\?[^"'<>\s]*)?/gi)) {
    candidates.push(match[0]);
  }

  const imageUrl = candidates
    .map((value) => absoluteUrl(decodeHtml(value), pageUrl))
    .find(isProductImage) || "";
  const description = cleanDescription($("meta[name='description']").attr("content") || "");
  const detailTitle = cleanDescription($("title").text() || "");

  return {
    imageUrl,
    description,
    detailTitle,
    fetchedAt: new Date().toISOString()
  };
}

function isProductImage(value) {
  const url = String(value || "").toLowerCase();
  return url.includes("assets.hikvision.com")
    && !url.includes("favicon")
    && !url.includes("logo")
    && !url.includes("/icons/")
    && /\.(png|jpg|jpeg|webp)(?:\.thumb|\?|$)/i.test(url);
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function cleanDescription(value) {
  return decodeHtml(value)
    .replace(/\s+/g, " ")
    .replace(/\s+-\s+Hikvision.*$/i, "")
    .trim();
}

function classify(series) {
  const haystack = [series.key, series.name, series.path.join("/")].join("/").toLowerCase();
  const categories = [];
  for (const rule of CATEGORY_RULES) {
    if (rule.terms.some((term) => haystack.includes(term))) categories.push(rule.id);
  }
  if (!categories.length) categories.push("accessory");
  return [...new Set(categories)];
}

function cleanName(value) {
  return String(value || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanModelName(value, url = "") {
  const cleaned = String(value || "")
    .replace(/\s*-\s*海康威视Hikvision.*$/i, "")
    .replace(/\s*-\s*Hikvision.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const fromUrl = modelCodeFromUrl(url);
  if (fromUrl) return fromUrl;
  if (looksLikeModelCode(cleaned)) return normalizeModelCode(cleaned);
  return cleaned;
}

function modelCodeFromUrl(value) {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).at(-1) || "";
    const normalized = normalizeModelCode(decodeURIComponent(segment));
    return looksLikeModelCode(normalized) ? normalized : "";
  } catch {
    return "";
  }
}

function normalizeModelCode(value) {
  return String(value || "")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toUpperCase();
}

function looksLikeModelCode(value) {
  const text = String(value || "").trim();
  return /[A-Z]{1,8}[\s-]*\d/i.test(text) && text.length <= 90;
}

function simplifyField(value) {
  return String(value || "").split(">").map((part) => part.trim()).filter(Boolean).slice(-2).join(" / ");
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.key)) map.set(item.key, item);
  }
  return [...map.values()];
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return fallback;
  }
}
