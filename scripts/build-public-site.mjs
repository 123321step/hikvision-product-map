import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SITE_DIR = path.join(ROOT, "site");
const MINDMAP_DIR = path.join(SITE_DIR, "mindmaps");
const CATALOG_FILE = path.join(SITE_DIR, "catalog.json");
const LOCALES = [
  { code: "cn", label: "\u4e2d\u6587", sitemap: "https://www.hikvision.com/cn/sitemap.xml", prefix: "/cn/products/" },
  { code: "en", label: "English", sitemap: "https://www.hikvision.com/en/sitemap.xml", prefix: "/en/products/" }
];

await mkdir(SITE_DIR, { recursive: true });

const diffData = await readJson(path.join(SITE_DIR, "diff-data.json"), null);
const previousCatalog = await readJson(CATALOG_FILE, null);
const diffLookup = new Map();
for (const locale of Object.values(diffData?.locales || {})) {
  for (const series of locale.topSeries || []) {
    diffLookup.set(`${locale.code}:${series.key}`, series);
  }
}

const locales = {};
for (const locale of LOCALES) {
  try {
    const response = await fetch(locale.sitemap, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const entries = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)]
      .map((match) => ({ url: match[1], lastmod: match[2] || "" }))
      .filter((entry) => entry.url.includes(locale.prefix))
      .map((entry) => buildEntry(locale, entry));

    const tree = buildTree(entries);
    const series = buildSeries(entries, locale.code);
    locales[locale.code] = {
      code: locale.code,
      label: locale.label,
      total: entries.length,
      models: entries.filter((entry) => entry.kind === "model").length,
      directories: entries.filter((entry) => entry.kind === "directory").length,
      seriesCount: series.length,
      entries,
      tree,
      series
    };
  } catch (error) {
    const cached = previousCatalog?.locales?.[locale.code];
    if (!cached) throw error;
    locales[locale.code] = cached;
  }
}

const catalog = {
  generatedAt: new Date().toISOString(),
  source: "Hikvision public sitemap",
  locales
};

await rm(MINDMAP_DIR, { recursive: true, force: true });
await mkdir(MINDMAP_DIR, { recursive: true });

const mindmaps = [];
for (const locale of Object.values(catalog.locales)) {
  const localeDiffs = Object.values(diffData?.locales || {}).find((item) => item.code === locale.code)?.topSeries || [];
  const overviewFile = `${locale.code}-overview.mmd`;
  const seriesOverviewFile = `${locale.code}-series-overview.mmd`;
  await writeFile(path.join(MINDMAP_DIR, overviewFile), overviewMap(locale), "utf8");
  await writeFile(path.join(MINDMAP_DIR, seriesOverviewFile), seriesOverviewMap(locale, diffLookup), "utf8");
  mindmaps.push({
    locale: locale.code,
    key: `${locale.code}:overview`,
    title: locale.code === "cn" ? "\u5168\u7ad9\u603b\u89c8" : "Overview",
    type: "overview",
    file: overviewFile,
    modelCount: locale.models,
    diffFields: 0
  });
  mindmaps.push({
    locale: locale.code,
    key: `${locale.code}:series-overview`,
    title: locale.code === "cn" ? "\u7cfb\u5217\u5206\u7c7b\u4e0e\u5dee\u5f02\u603b\u89c8" : "Series Overview And Differences",
    type: "series-overview",
    file: seriesOverviewFile,
    modelCount: locale.models,
    diffFields: localeDiffs.reduce((sum, item) => sum + (item?.differences?.length || 0), 0)
  });

  for (const series of locale.series) {
    const file = `${locale.code}-${slug(series.key)}.mmd`;
    await writeFile(
      path.join(MINDMAP_DIR, file),
      seriesMap(locale, series, diffLookup.get(`${locale.code}:${series.key}`)),
      "utf8"
    );
    mindmaps.push({
      locale: locale.code,
      key: series.key,
      title: series.name,
      type: "series",
      file,
      modelCount: series.modelCount,
      diffFields: diffLookup.get(`${locale.code}:${series.key}`)?.differences?.length || 0
    });
  }
}

await writeFile(CATALOG_FILE, JSON.stringify(catalog), "utf8");
await writeFile(
  path.join(MINDMAP_DIR, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), maps: mindmaps }),
  "utf8"
);
await writeFile(path.join(SITE_DIR, ".nojekyll"), "", "utf8");
await writeFile(path.join(SITE_DIR, "index.html"), html(), "utf8");

function buildEntry(locale, entry) {
  const parts = new URL(entry.url).pathname.split("/").filter(Boolean);
  const productPath = parts.slice(2);
  const slugValue = productPath.at(-1) || "";
  return {
    locale: locale.code,
    url: entry.url,
    lastmod: entry.lastmod,
    depth: parts.length,
    kind: parts.length >= 6 ? "model" : "directory",
    slug: slugValue,
    path: productPath,
    name: displayName(locale.code, productPath)
  };
}

function buildTree(entries) {
  const root = { name: "Products", key: "root", children: [] };
  const map = new Map([["root", root]]);

  for (const entry of entries.filter((item) => item.kind === "directory")) {
    let parent = "root";
    for (let index = 0; index < entry.path.length; index += 1) {
      const current = entry.path.slice(0, index + 1).join("/");
      if (!map.has(current)) {
        const node = {
          key: current,
          name: displayName(entry.locale, entry.path.slice(0, index + 1)),
          url: buildUrl(entry.locale, entry.path.slice(0, index + 1)),
          children: []
        };
        map.set(current, node);
        map.get(parent).children.push(node);
      }
      parent = current;
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node) {
  node.children.sort((left, right) => left.name.localeCompare(right.name));
  node.children.forEach(sortTree);
}

function buildSeries(entries, localeCode) {
  const groups = new Map();
  for (const model of entries.filter((entry) => entry.kind === "model")) {
    const seriesPath = model.path.slice(0, -1);
    const key = seriesPath.join("/");
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        locale: localeCode,
        name: displayName(localeCode, seriesPath),
        path: seriesPath,
        url: buildUrl(localeCode, seriesPath),
        models: []
      });
    }
    groups.get(key).models.push({ name: model.name, slug: model.slug, url: model.url });
  }

  return [...groups.values()]
    .map((series) => ({
      ...series,
      modelCount: series.models.length,
      models: series.models.sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => right.modelCount - left.modelCount || left.name.localeCompare(right.name));
}

function displayName(localeCode, segments) {
  const last = segments.at(-1) || "";
  if (/^(ds|ids|i?ds)-/i.test(last)) return last;
  if (/^s\d+$/i.test(last)) return last.toUpperCase();

  const useful = [...segments].reverse().find((segment) => !/^s\d+$/i.test(segment)) || last;
  if (localeCode === "cn") return useful;

  return String(useful)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function buildUrl(localeCode, productPath) {
  return `https://www.hikvision.com/${localeCode}/products/${productPath.join("/")}/`;
}

function overviewMap(locale) {
  const lines = ["mindmap", `  root(("${esc(locale.label)}"))`];
  for (const top of locale.tree.children.slice(0, 12)) {
    lines.push(`    "${esc(top.name)}"`);
    for (const child of (top.children || []).slice(0, 8)) {
      lines.push(`      "${esc(child.name)}"`);
    }
  }
  return lines.join("\n");
}

function seriesOverviewMap(locale, diffLookup) {
  const groups = new Map();
  for (const series of locale.series) {
    const categoryKey = series.path[0] || "Other";
    if (!groups.has(categoryKey)) {
      groups.set(categoryKey, []);
    }
    groups.get(categoryKey).push(series);
  }

  const sortedGroups = [...groups.entries()]
    .map(([category, items]) => [category, items.sort((left, right) => right.modelCount - left.modelCount)])
    .sort((left, right) => right[1][0].modelCount - left[1][0].modelCount);

  const lines = [
    "mindmap",
    `  root(("${esc(locale.code === "cn" ? "按系列分类看产品差异" : "Series View With Differences")}"))`
  ];

  for (const [category, items] of sortedGroups.slice(0, 10)) {
    lines.push(`    "${esc(humanizeSegment(locale.code, category))}"`);
    for (const series of items.slice(0, 8)) {
      const diff = diffLookup.get(`${locale.code}:${series.key}`);
      const label = `${series.name} | ${locale.code === "cn" ? "型号" : "models"} ${series.modelCount}`;
      lines.push(`      "${esc(label)}"`);
      if (diff?.differences?.length) {
        lines.push(`        "${locale.code === "cn" ? `已对比 ${diff.specCoverage} 个型号` : `${diff.specCoverage} models compared`}"`);
        for (const field of diff.differences.slice(0, 3)) {
          lines.push(`        "${esc(simplifyField(field.field))}"`);
        }
      } else {
        lines.push(`        "${locale.code === "cn" ? "\u6682\u65e0\u89c4\u683c\u5dee\u5f02\u6570\u636e" : "No diff data yet"}"`);
      }
    }
  }
  return lines.join("\n");
}

function seriesMap(locale, series, diff) {
  const category = humanizeSegment(locale.code, series.path[0] || "Other");
  const subcategory = humanizeSegment(locale.code, series.path[1] || "");
  const lines = [
    "mindmap",
    `  root(("${esc(series.name)}"))`,
    `    "${esc(locale.code === "cn" ? `所属大类: ${category}` : `Category: ${category}`)}"`,
    ...(subcategory ? [`    "${esc(locale.code === "cn" ? `子类: ${subcategory}` : `Subcategory: ${subcategory}`)}"`] : []),
    `    "${locale.code === "cn" ? "\u578b\u53f7\u6570" : "Models"}: ${series.modelCount}"`,
    `    "${locale.code === "cn" ? "\u578b\u53f7\u5217\u8868" : "Models"}"`
  ];

  for (const model of series.models.slice(0, 8)) {
    lines.push(`      "${esc(trimModelName(model.name))}"`);
  }
  if (series.models.length > 8) {
    lines.push(
      `      "${locale.code === "cn" ? `\u5176\u4f59 ${series.models.length - 8} \u4e2a\u578b\u53f7` : `${series.models.length - 8} more models`}"`
    );
  }
  if (diff?.differences?.length) {
    lines.push(`    "${locale.code === "cn" ? "\u5bf9\u6bd4\u6982\u8981" : "Comparison Summary"}"`);
    lines.push(`      "${esc(locale.code === "cn" ? `已对比 ${diff.specCoverage} / ${diff.modelCount} 个型号` : `${diff.specCoverage} / ${diff.modelCount} models compared`)}"`);
    lines.push(`      "${esc(locale.code === "cn" ? `共发现 ${diff.differences.length} 个差异字段` : `${diff.differences.length} differing fields found`)}"`);
    lines.push(`    "${locale.code === "cn" ? "\u4e3b\u8981\u5dee\u5f02" : "Key Differences"}"`);
    for (const item of diff.differences.slice(0, 6)) {
      lines.push(`      "${esc(formatDifference(locale.code, item))}"`);
    }
  } else {
    lines.push(`    "${locale.code === "cn" ? "\u6682\u65e0\u89c4\u683c\u5bf9\u6bd4\u6570\u636e" : "No specification comparison yet"}"`);
  }
  return lines.join("\n");
}

function humanizeSegment(localeCode, value) {
  if (!value) return "";
  if (localeCode === "cn") return value;
  return String(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function simplifyField(value) {
  return String(value || "").split(">").map((part) => part.trim()).filter(Boolean).slice(-2).join(" / ");
}

function trimModelName(value) {
  return String(value || "")
    .replace(/\s*-\s*.*?Hikvision.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDifference(localeCode, item) {
  const values = Object.values(item.values || {}).filter(Boolean);
  const unique = [...new Set(values.map((value) => String(value).trim()))].slice(0, 3);
  const field = simplifyField(item.field);
  if (!unique.length) return field;
  return localeCode === "cn"
    ? `${field}: ${unique.join(" / ")}`
    : `${field}: ${unique.join(" / ")}`;
}

function esc(value) {
  return String(value || "")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
    .trim();
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return fallback;
  }
}

function html() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hikvision Product Atlas</title><style>
  :root{--bg:#f5f0e8;--panel:#fffaf4;--text:#1d2a33;--muted:#61717b;--line:#dccfbe;--brand:#c6362e;--brand-soft:#f4ddda;--accent:#20455e;--accent-soft:#eef4f7}
  *{box-sizing:border-box}body{margin:0;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);background:radial-gradient(circle at top left,#fff5e3 0,transparent 28%),radial-gradient(circle at top right,#f8dfd6 0,transparent 24%),linear-gradient(180deg,#f6efe5 0%,#efe7db 100%)}.shell{max-width:1520px;margin:0 auto;padding:24px;display:grid;grid-template-columns:320px 1fr;gap:20px}.panel{background:rgba(255,250,244,.94);border:1px solid var(--line);border-radius:20px;padding:20px;box-shadow:0 12px 40px rgba(82,52,32,.08)}.hero{background:linear-gradient(135deg,rgba(198,54,46,.08),rgba(32,69,94,.08));border:1px solid var(--line);border-radius:20px;padding:18px;margin-bottom:18px}.badge{display:inline-block;border-radius:999px;padding:4px 10px;background:var(--brand-soft);color:var(--brand);font-size:12px;margin-bottom:10px}.selector-link{display:block;margin:0 0 16px;padding:10px 12px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none}.selector-link:hover{text-decoration:none;background:#16384d}h1,h2,h3,p{margin-top:0}.muted{color:var(--muted)}.tabs,.filters,.layout-tabs{display:flex;flex-wrap:wrap;gap:10px}button{border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--text);padding:8px 14px;cursor:pointer;font:inherit}button.active{background:var(--brand);color:#fff;border-color:var(--brand)}input{width:100%;padding:11px 12px;border-radius:12px;border:1px solid var(--line);background:#fff;font:inherit}.stats,.grid{display:grid;gap:12px}.stats{grid-template-columns:repeat(5,1fr);margin-bottom:16px}.grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}.card{border:1px solid var(--line);border-radius:16px;padding:16px;background:#fff}.count{font-size:22px;font-weight:700}.content-grid{display:grid;grid-template-columns:340px 1fr;gap:16px}.card a{color:var(--accent);text-decoration:none;word-break:break-all}.card a:hover{text-decoration:underline}.tree ul{list-style:none;margin:8px 0 0;padding-left:18px;border-left:1px solid var(--line)}.tree li{margin:8px 0;position:relative}.tree li::before{content:"";position:absolute;left:-18px;top:12px;width:12px;border-top:1px solid var(--line)}.series-list,.model-list,.diff-preview,.mindmap-list{max-height:70vh;overflow:auto;display:grid;gap:10px}.series-item,.mindmap-item{width:100%;text-align:left;border-radius:14px}.model-link,.preview-item{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:12px;color:var(--accent);background:#fff;text-decoration:none}.preview-item{color:var(--text);background:var(--accent-soft)}table{width:100%;border-collapse:collapse;background:#fff;font-size:14px}th,td{border:1px solid var(--line);padding:10px;text-align:left;vertical-align:top}th{background:#faf1e8;position:sticky;top:0}.scroll{overflow:auto}#mindmapRender{min-height:520px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px}#mindmapRender svg{min-width:100%;height:auto}pre.mmd-source{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px;margin-top:14px}@media(max-width:980px){.shell,.content-grid{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}
  </style><script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";window.__mermaid=mermaid;mermaid.initialize({startOnLoad:false,securityLevel:"loose",theme:"neutral"});</script></head><body>
  <div class="shell"><aside class="panel"><h1>Hikvision Product Atlas</h1><p class="muted">Public bilingual catalog with visible Mermaid mind maps.</p><a class="selector-link" href="./selector.html">\u5728\u7ebf\u9009\u578b / Solution Topology</a><div class="hero"><div class="badge">Live Snapshot</div><p id="updated" class="muted"></p><p id="changeSummary" class="muted"></p></div><h3>Language</h3><div class="tabs"><button class="active" data-locale="cn">\u4e2d\u6587</button><button data-locale="en">English</button></div><h3 style="margin-top:18px;">Search</h3><input id="search" placeholder="Search model / series / path / mindmap"><h3 style="margin-top:18px;">Type</h3><div class="filters"><button class="active" data-kind="all">All</button><button data-kind="model">Model</button><button data-kind="directory">Directory</button></div></aside><main class="panel"><div class="stats"><div class="card"><div class="muted">Total URLs</div><div class="count" id="total"></div></div><div class="card"><div class="muted">Models</div><div class="count" id="models"></div></div><div class="card"><div class="muted">Directories</div><div class="count" id="directories"></div></div><div class="card"><div class="muted">Series</div><div class="count" id="seriesCount"></div></div><div class="card"><div class="muted">Changed Specs</div><div class="count" id="changedSpecs"></div></div></div><div id="changesPanel" class="grid" style="margin-bottom:16px;"></div><div class="layout-tabs"><button class="active" data-view="catalog">Catalog</button><button data-view="series">Series</button><button data-view="diffs">Diffs</button><button data-view="mindmaps">Mindmaps</button><button data-view="tree">Tree</button></div><div id="content"></div></main></div>
  <script>
  const state={locale:"cn",kind:"all",query:"",view:"catalog",seriesKey:null,mindmapKey:null};
  const copy={cn:{updated:"\u66f4\u65b0\u65f6\u95f4",thisRun:"\u672c\u6b21\u66f4\u65b0",added:"\u65b0\u589e\u94fe\u63a5",removed:"\u79fb\u9664\u94fe\u63a5",changed:"\u89c4\u683c\u53d8\u66f4",tree:"\u4ea7\u54c1\u6811",depth:"\u5c42\u7ea7",slug:"\u6807\u8bc6",noCatalog:"\u6ca1\u6709\u5339\u914d\u5230\u76ee\u5f55\u3002",noSeries:"\u6ca1\u6709\u5339\u914d\u5230\u7cfb\u5217\u3002",noData:"\u6682\u65e0\u5dee\u5f02\u6570\u636e",specCoverage:"\u89c4\u683c\u8986\u76d6",diffFields:"\u5dee\u5f02\u5b57\u6bb5",diffPreview:"\u7cfb\u5217\u5dee\u5f02\u9884\u89c8",openDiffs:"\u5728 Diffs \u4e2d\u67e5\u770b\u5b8c\u6574\u5bf9\u6bd4",mindmaps:"\u601d\u7ef4\u5bfc\u56fe",noMindmaps:"\u6ca1\u6709\u5339\u914d\u5230\u601d\u7ef4\u5bfc\u56fe\u3002",openSource:"\u6253\u5f00 .mmd \u6e90\u6587\u4ef6",modelCount:"\u578b\u53f7\u6570"},en:{updated:"Updated",thisRun:"This Run",added:"Added URLs",removed:"Removed URLs",changed:"Changed Specs",tree:"Product Tree",depth:"Depth",slug:"Slug",noCatalog:"No matching catalog entries found.",noSeries:"No matching series found.",noData:"No diff data yet",specCoverage:"Spec coverage",diffFields:"Diff fields",diffPreview:"Series Diff Preview",openDiffs:"Open full comparison in Diffs",mindmaps:"Mindmaps",noMindmaps:"No matching mindmaps found.",openSource:"Open .mmd source",modelCount:"Models"}};
  const updated=document.getElementById("updated"),changeSummary=document.getElementById("changeSummary"),total=document.getElementById("total"),models=document.getElementById("models"),directories=document.getElementById("directories"),seriesCount=document.getElementById("seriesCount"),changedSpecs=document.getElementById("changedSpecs"),changesPanel=document.getElementById("changesPanel"),content=document.getElementById("content");
  Promise.all([fetch("./catalog.json").then(r=>r.json()),fetch("./diff-data.json").then(r=>r.ok?r.json():null).catch(()=>null),fetch("./mindmaps/index.json").then(r=>r.ok?r.json():{maps:[]}).catch(()=>({maps:[]}))]).then(([catalog,diffData,mindmapIndex])=>{
    const diffLocales=diffData?.locales||{};
    const t=k=>copy[state.locale][k]||k;
    const dt=v=>new Date(v).toLocaleString(state.locale==="cn"?"zh-CN":"en-US");
    const e=v=>String(v||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    const tree=node=>"<li>"+(node.url?'<a href="'+node.url+'" target="_blank" rel="noreferrer">'+e(node.name)+"</a>":e(node.name))+((node.children||[]).length?"<ul>"+node.children.map(tree).join("")+"</ul>":"")+"</li>";
    const renderChanges=()=>{const c=diffData?.changes||{};const cards=[{label:t("added"),value:c.addedUrls||0},{label:t("removed"),value:c.removedUrls||0},{label:t("changed"),value:c.changedSpecs||0}];changesPanel.innerHTML=cards.map(x=>'<article class="card"><div class="muted">'+e(x.label)+'</div><div class="count">'+Number(x.value).toLocaleString()+"</div></article>").join("");updated.textContent=t("updated")+": "+dt(catalog.generatedAt);changeSummary.textContent=t("thisRun")+": +"+Number(c.addedUrls||0).toLocaleString()+" / -"+Number(c.removedUrls||0).toLocaleString()+" / "+t("changed")+" "+Number(c.changedSpecs||0).toLocaleString();};
    const renderMindmap=async(file,key)=>{const target=document.getElementById("mindmapRender"),source=document.getElementById("mindmapSource");if(!target||!source)return;const text=await fetch("./mindmaps/"+file).then(r=>r.text());source.textContent=text;const result=await window.__mermaid.render("mindmap-"+key.replace(/[^a-z0-9]+/gi,"-"),text);target.innerHTML=result.svg;};
    const render=()=>{renderChanges();const locale=catalog.locales[state.locale];total.textContent=locale.total.toLocaleString();models.textContent=locale.models.toLocaleString();directories.textContent=locale.directories.toLocaleString();seriesCount.textContent=locale.seriesCount.toLocaleString();changedSpecs.textContent=Number(diffData?.changes?.changedSpecs||0).toLocaleString();const q=state.query.trim().toLowerCase();
      if(state.view==="catalog"){let entries=locale.entries;if(state.kind!=="all")entries=entries.filter(x=>x.kind===state.kind);if(q)entries=entries.filter(x=>[x.name,x.slug,x.path.join("/")].join(" ").toLowerCase().includes(q));const view=entries.slice(0,500);content.innerHTML=view.length?'<div class="grid">'+view.map(x=>'<article class="card"><div class="badge">'+e(x.kind)+'</div><h3>'+e(x.name)+'</h3><p class="muted">'+t("depth")+": "+x.depth+" | "+t("slug")+": "+e(x.slug)+'</p><p class="muted">'+e(x.path.join(" / "))+'</p><a href="'+x.url+'" target="_blank" rel="noreferrer">'+e(x.url)+"</a></article>").join("")+"</div>":'<div class="card"><h2>'+t("noCatalog")+"</h2></div>";return;}
      if(state.view==="tree"){content.innerHTML='<div class="card tree"><h2>'+e(locale.label)+" "+t("tree")+"</h2><ul>"+tree(locale.tree)+"</ul></div>";return;}
      if(state.view==="diffs"){let list=diffLocales[state.locale]?.topSeries||[];if(q)list=list.filter(x=>[x.name,...x.models.map(m=>m.name)].join(" ").toLowerCase().includes(q));const selected=list.find(x=>x.key===state.seriesKey)||list[0];state.seriesKey=selected?.key||null;const left='<div class="series-list">'+list.map(x=>'<button class="series-item '+(selected&&x.key===selected.key?"active":"")+'" data-series="'+x.key+'">'+e(x.name)+" ("+x.specCoverage+"/"+x.modelCount+")</button>").join("")+"</div>";let right='<div class="card"><h2>'+t("noData")+"</h2></div>";if(selected){const headers=selected.models.map(m=>"<th>"+e(m.name)+"</th>").join("");const rows=(selected.differences.length?selected.differences:[{field:t("noData"),values:{}}]).map(diff=>"<tr><td>"+e(diff.field)+"</td>"+selected.models.map(m=>"<td>"+e(diff.values[m.name]||"")+"</td>").join("")+"</tr>").join("");right='<div class="card"><div class="badge">diffs</div><h2>'+e(selected.name)+'</h2><p class="muted">'+t("specCoverage")+": "+selected.specCoverage+" / "+selected.modelCount+" | "+t("diffFields")+": "+selected.differences.length+'</p><p><a href="'+selected.url+'" target="_blank" rel="noreferrer">'+e(selected.url)+'</a></p><div class="scroll"><table><thead><tr><th>Field</th>'+headers+"</tr></thead><tbody>"+rows+"</tbody></table></div></div>";}content.innerHTML='<div class="content-grid">'+left+right+"</div>";return;}
      if(state.view==="mindmaps"){let list=(mindmapIndex.maps||[]).filter(x=>x.locale===state.locale);if(q)list=list.filter(x=>[x.title,x.key,x.type,x.file].join(" ").toLowerCase().includes(q));const selected=list.find(x=>x.key===state.mindmapKey)||list[0];state.mindmapKey=selected?.key||null;const left='<div class="mindmap-list">'+list.map(x=>'<button class="mindmap-item '+(selected&&x.key===selected.key?"active":"")+'" data-mindmap="'+x.key+'">'+e(x.title)+" ("+x.modelCount+")</button>").join("")+"</div>";const right=selected?'<div class="card"><div class="badge">'+t("mindmaps")+'</div><h2>'+e(selected.title)+'</h2><p class="muted">'+t("modelCount")+": "+selected.modelCount+(selected.diffFields?" | "+t("diffFields")+": "+selected.diffFields:"")+'</p><p><a href="./mindmaps/'+selected.file+'" target="_blank" rel="noreferrer">'+t("openSource")+'</a></p><div id="mindmapRender"></div><pre id="mindmapSource" class="mmd-source"></pre></div>':'<div class="card"><h2>'+t("noMindmaps")+"</h2></div>";content.innerHTML='<div class="content-grid">'+left+right+"</div>";if(selected)queueMicrotask(()=>renderMindmap(selected.file,selected.key));return;}
      let list=locale.series;if(q)list=list.filter(x=>[x.name,x.path.join("/"),...x.models.map(m=>m.name)].join(" ").toLowerCase().includes(q));const selected=list.find(x=>x.key===state.seriesKey)||list[0];state.seriesKey=selected?.key||null;const left='<div class="series-list">'+list.slice(0,500).map(x=>'<button class="series-item '+(selected&&x.key===selected.key?"active":"")+'" data-series="'+x.key+'">'+e(x.name)+" ("+x.modelCount+")</button>").join("")+"</div>";let right='<div class="card"><h2>'+t("noSeries")+"</h2></div>";if(selected){const diff=(diffLocales[state.locale]?.topSeries||[]).find(x=>x.key===selected.key);const map=(mindmapIndex.maps||[]).find(x=>x.locale===state.locale&&x.key===selected.key);const preview=diff?'<div class="card" style="margin-top:14px;"><div class="badge">diffs</div><h3>'+t("diffPreview")+'</h3><p class="muted">'+t("specCoverage")+": "+diff.specCoverage+" / "+diff.modelCount+" | "+t("diffFields")+": "+diff.differences.length+'</p><div class="diff-preview">'+diff.differences.slice(0,8).map(item=>'<div class="preview-item"><strong>'+e(item.field)+'</strong><br><span class="muted">'+Object.entries(item.values).slice(0,2).map(([n,v])=>e(n)+": "+e(v)).join(" | ")+"</span></div>").join("")+'</div><p style="margin-top:12px;"><button data-open-diffs="true">'+t("openDiffs")+"</button></p></div>":"";const mapBtn=map?'<p><button data-open-mindmap="'+map.key+'">'+t("mindmaps")+"</button></p>":"";right='<div><div class="card"><div class="badge">series</div><h2>'+e(selected.name)+'</h2><p class="muted">'+t("modelCount")+": "+selected.modelCount+'</p><p class="muted">'+e(selected.path.join(" / "))+'</p><p><a href="'+selected.url+'" target="_blank" rel="noreferrer">'+e(selected.url)+'</a></p>'+mapBtn+'<div class="model-list">'+selected.models.slice(0,1000).map(m=>'<a class="model-link" href="'+m.url+'" target="_blank" rel="noreferrer">'+e(m.name)+"</a>").join("")+"</div></div>"+preview+"</div>";}content.innerHTML='<div class="content-grid">'+left+right+"</div>";};
    document.querySelector(".tabs").addEventListener("click",ev=>{const btn=ev.target.closest("button[data-locale]");if(!btn)return;state.locale=btn.dataset.locale;state.seriesKey=null;state.mindmapKey=null;document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("active",b===btn));render();});
    document.querySelector(".filters").addEventListener("click",ev=>{const btn=ev.target.closest("button[data-kind]");if(!btn)return;state.kind=btn.dataset.kind;document.querySelectorAll(".filters button").forEach(b=>b.classList.toggle("active",b===btn));render();});
    document.querySelector(".layout-tabs").addEventListener("click",ev=>{const btn=ev.target.closest("button[data-view]");if(!btn)return;state.view=btn.dataset.view;document.querySelectorAll(".layout-tabs button").forEach(b=>b.classList.toggle("active",b===btn));render();});
    document.getElementById("search").addEventListener("input",ev=>{state.query=ev.target.value;render();});
    content.addEventListener("click",ev=>{const s=ev.target.closest("button[data-series]"),m=ev.target.closest("button[data-mindmap]"),d=ev.target.closest("button[data-open-diffs]"),om=ev.target.closest("button[data-open-mindmap]");if(s){state.seriesKey=s.dataset.series;render();return;}if(m){state.mindmapKey=m.dataset.mindmap;render();return;}if(d){state.view="diffs";document.querySelectorAll(".layout-tabs button").forEach(b=>b.classList.toggle("active",b.dataset.view==="diffs"));render();return;}if(om){state.view="mindmaps";state.mindmapKey=om.dataset.openMindmap;document.querySelectorAll(".layout-tabs button").forEach(b=>b.classList.toggle("active",b.dataset.view==="mindmaps"));render();}});
    render();
  });
  </script></body></html>`;
}
