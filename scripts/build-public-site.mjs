import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SITE_DIR = path.join(ROOT, "site");

const LOCALES = [
  { code: "cn", label: "中文", sitemap: "https://www.hikvision.com/cn/sitemap.xml", prefix: "/cn/products/" },
  { code: "en", label: "English", sitemap: "https://www.hikvision.com/en/sitemap.xml", prefix: "/en/products/" }
];

await mkdir(SITE_DIR, { recursive: true });

const locales = {};
for (const locale of LOCALES) {
  const xml = await fetch(locale.sitemap, { headers: { "user-agent": "Mozilla/5.0" } }).then((r) => r.text());
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const productUrls = urls.filter((url) => url.includes(locale.prefix));
  const entries = productUrls.map((url) => buildEntry(locale, url));
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
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: "Hikvision public sitemap",
  locales
};

await writeFile(path.join(SITE_DIR, "catalog.json"), JSON.stringify(payload), "utf8");
await writeFile(path.join(SITE_DIR, ".nojekyll"), "", "utf8");
await writeFile(path.join(SITE_DIR, "index.html"), renderHtml(), "utf8");

function buildEntry(locale, url) {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const productPath = parts.slice(2);
  const slug = productPath.at(-1) || "";
  const kind = parts.length >= 6 ? "model" : "directory";
  return {
    locale: locale.code,
    url,
    depth: parts.length,
    kind,
    slug,
    path: productPath,
    name: displayName(locale.code, productPath)
  };
}

function buildTree(entries) {
  const root = { name: "Products", key: "root", children: [] };
  const nodeMap = new Map([["root", root]]);

  for (const entry of entries.filter((item) => item.kind === "directory")) {
    let parentKey = "root";
    for (let index = 0; index < entry.path.length; index += 1) {
      const segmentPath = entry.path.slice(0, index + 1);
      const key = segmentPath.join("/");
      if (!nodeMap.has(key)) {
        nodeMap.set(key, {
          key,
          name: displayName(entry.locale, segmentPath),
          url: buildUrl(entry.locale, segmentPath),
          children: []
        });
        nodeMap.get(parentKey).children.push(nodeMap.get(key));
      }
      parentKey = key;
    }
  }

  sortTree(root);
  return root;
}

function sortTree(node) {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.children.forEach(sortTree);
}

function buildSeries(entries, localeCode) {
  const models = entries.filter((entry) => entry.kind === "model");
  const grouped = new Map();

  for (const model of models) {
    const seriesPath = model.path.slice(0, -1);
    const key = seriesPath.join("/");
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        locale: localeCode,
        name: displayName(localeCode, seriesPath),
        path: seriesPath,
        url: buildUrl(localeCode, seriesPath),
        models: []
      });
    }
    grouped.get(key).models.push({
      name: model.name,
      slug: model.slug,
      url: model.url
    });
  }

  return [...grouped.values()]
    .map((series) => ({
      ...series,
      modelCount: series.models.length,
      models: series.models.sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => b.modelCount - a.modelCount || a.name.localeCompare(b.name));
}

function buildUrl(localeCode, productPath) {
  return `https://www.hikvision.com/${localeCode}/products/${productPath.join("/")}/`;
}

function displayName(localeCode, segments) {
  const last = segments.at(-1) || "";
  if (/^(ds|ids|i?ds)-/i.test(last)) return last;
  if (/^s\d+$/i.test(last)) return last.toUpperCase();
  const useful = [...segments].reverse().find((segment) => !/^s\d+$/i.test(segment)) || last;
  return localeCode === "cn" ? useful : humanize(useful);
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hikvision Full Product Catalog</title>
  <style>
    :root {
      --bg: #f5f0e8;
      --panel: #fffaf4;
      --text: #1d2a33;
      --muted: #61717b;
      --line: #dccfbe;
      --brand: #c6362e;
      --brand-soft: #f4ddda;
      --accent: #20455e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, #fff5e3 0, transparent 28%),
        radial-gradient(circle at top right, #f8dfd6 0, transparent 24%),
        linear-gradient(180deg, #f6efe5 0%, #efe7db 100%);
    }
    .shell {
      max-width: 1480px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 20px;
    }
    .panel {
      background: rgba(255,250,244,.94);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 20px;
      box-shadow: 0 12px 40px rgba(82,52,32,.08);
    }
    .hero {
      background: linear-gradient(135deg, rgba(198,54,46,.08), rgba(32,69,94,.08));
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      margin-bottom: 18px;
    }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 4px 10px;
      background: var(--brand-soft);
      color: var(--brand);
      font-size: 12px;
      margin-bottom: 10px;
    }
    h1, h2, h3, p { margin-top: 0; }
    .muted { color: var(--muted); }
    .tabs, .filters { display: flex; flex-wrap: wrap; gap: 10px; }
    button {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
      padding: 8px 14px;
      cursor: pointer;
    }
    button.active {
      background: var(--brand);
      color: #fff;
      border-color: var(--brand);
    }
    input {
      width: 100%;
      padding: 11px 12px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: white;
      font: inherit;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: #fff;
    }
    .count { font-size: 22px; font-weight: 700; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      background: #fff;
    }
    .card a { color: var(--accent); text-decoration: none; word-break: break-all; }
    .card a:hover { text-decoration: underline; }
    .tree ul { list-style: none; margin: 8px 0 0; padding-left: 18px; border-left: 1px solid var(--line); }
    .tree li { margin: 8px 0; position: relative; }
    .tree li::before { content: ""; position: absolute; left: -18px; top: 12px; width: 12px; border-top: 1px solid var(--line); }
    .series-list { max-height: 70vh; overflow: auto; display: grid; gap: 10px; }
    .series-item { width: 100%; text-align: left; border-radius: 14px; }
    .model-list { display: grid; gap: 10px; max-height: 70vh; overflow: auto; }
    .model-link { display: block; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--accent); background: #fff; text-decoration: none; }
    .layout-tabs { display: flex; gap: 10px; margin-bottom: 14px; }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel">
      <h1>Hikvision Full Product Catalog</h1>
      <p class="muted">Full public catalog from Hikvision sitemaps. This version adds full series grouping and per-series model lists.</p>
      <div class="hero">
        <div class="badge">Full Coverage</div>
        <p id="updated" class="muted"></p>
      </div>
      <h3>Language</h3>
      <div class="tabs">
        <button class="active" data-locale="cn">中文</button>
        <button data-locale="en">English</button>
      </div>
      <h3 style="margin-top:18px;">Search</h3>
      <input id="search" placeholder="Search model / series / slug / path">
      <h3 style="margin-top:18px;">Type</h3>
      <div class="filters">
        <button class="active" data-kind="all">All</button>
        <button data-kind="model">Model</button>
        <button data-kind="directory">Directory</button>
      </div>
    </aside>
    <main class="panel">
      <div class="stats">
        <div class="stat"><div class="muted">Total URLs</div><div class="count" id="total"></div></div>
        <div class="stat"><div class="muted">Models</div><div class="count" id="models"></div></div>
        <div class="stat"><div class="muted">Directories</div><div class="count" id="directories"></div></div>
        <div class="stat"><div class="muted">Series</div><div class="count" id="seriesCount"></div></div>
      </div>
      <div class="layout-tabs">
        <button class="active" data-view="catalog">Catalog</button>
        <button data-view="series">Series</button>
        <button data-view="tree">Tree</button>
      </div>
      <div id="content"></div>
    </main>
  </div>
  <script>
    const state = { locale: 'cn', kind: 'all', query: '', view: 'catalog', seriesKey: null };
    const updated = document.getElementById('updated');
    const total = document.getElementById('total');
    const models = document.getElementById('models');
    const directories = document.getElementById('directories');
    const seriesCount = document.getElementById('seriesCount');
    const content = document.getElementById('content');

    fetch('./catalog.json')
      .then(r => r.json())
      .then(data => {
        updated.textContent = 'Updated: ' + new Date(data.generatedAt).toLocaleString();

        const renderTree = (node) => {
          const children = (node.children || []).map(renderTree).join('');
          const label = node.url ? '<a href="' + node.url + '" target="_blank" rel="noreferrer">' + node.name + '</a>' : node.name;
          return '<li>' + label + (children ? '<ul>' + children + '</ul>' : '') + '</li>';
        };

        const render = () => {
          const locale = data.locales[state.locale];
          total.textContent = locale.total.toLocaleString();
          models.textContent = locale.models.toLocaleString();
          directories.textContent = locale.directories.toLocaleString();
          seriesCount.textContent = locale.seriesCount.toLocaleString();
          const q = state.query.trim().toLowerCase();

          if (state.view === 'catalog') {
            let entries = locale.entries;
            if (state.kind !== 'all') entries = entries.filter(e => e.kind === state.kind);
            if (q) entries = entries.filter(e => [e.name, e.slug, e.path.join('/')].join(' ').toLowerCase().includes(q));
            const view = entries.slice(0, 500);
            content.innerHTML = '<div class="grid">' + view.map(entry => '<article class="card"><div class="badge">' + entry.kind + '</div><h3>' + entry.name + '</h3><p class="muted">Depth: ' + entry.depth + ' | Slug: ' + entry.slug + '</p><p class="muted">' + entry.path.join(' / ') + '</p><a href="' + entry.url + '" target="_blank" rel="noreferrer">' + entry.url + '</a></article>').join('') + '</div>';
            return;
          }

          if (state.view === 'tree') {
            content.innerHTML = '<div class="card tree"><h2>' + locale.label + ' Tree</h2><ul>' + renderTree(locale.tree) + '</ul></div>';
            return;
          }

          let series = locale.series;
          if (q) series = series.filter(s => [s.name, s.path.join('/'), ...s.models.map(m => m.name)].join(' ').toLowerCase().includes(q));
          const selected = series.find(s => s.key === state.seriesKey) || series[0];
          state.seriesKey = selected ? selected.key : null;
          const left = '<div class="series-list">' + series.slice(0, 500).map(s => '<button class="series-item ' + (selected && s.key === selected.key ? 'active' : '') + '" data-series="' + s.key + '">' + s.name + ' (' + s.modelCount + ')</button>').join('') + '</div>';
          let right = '<div class="card"><h2>No series found</h2></div>';
          if (selected) {
            right = '<div class="card"><div class="badge">series</div><h2>' + selected.name + '</h2><p class="muted">Models: ' + selected.modelCount + '</p><p class="muted">' + selected.path.join(' / ') + '</p><p><a href="' + selected.url + '" target="_blank" rel="noreferrer">' + selected.url + '</a></p><div class="model-list">' + selected.models.slice(0, 1000).map(m => '<a class="model-link" href="' + m.url + '" target="_blank" rel="noreferrer">' + m.name + '</a>').join('') + '</div></div>';
          }
          content.innerHTML = '<div style="display:grid;grid-template-columns:340px 1fr;gap:16px;">' + left + right + '</div>';
        };

        document.querySelector('.tabs').addEventListener('click', (event) => {
          const btn = event.target.closest('button[data-locale]');
          if (!btn) return;
          state.locale = btn.dataset.locale;
          state.seriesKey = null;
          document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
          render();
        });

        document.querySelector('.filters').addEventListener('click', (event) => {
          const btn = event.target.closest('button[data-kind]');
          if (!btn) return;
          state.kind = btn.dataset.kind;
          document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('active', b === btn));
          render();
        });

        document.querySelector('.layout-tabs').addEventListener('click', (event) => {
          const btn = event.target.closest('button[data-view]');
          if (!btn) return;
          state.view = btn.dataset.view;
          document.querySelectorAll('.layout-tabs button').forEach(b => b.classList.toggle('active', b === btn));
          render();
        });

        document.getElementById('search').addEventListener('input', (event) => {
          state.query = event.target.value;
          render();
        });

        content.addEventListener('click', (event) => {
          const btn = event.target.closest('button[data-series]');
          if (!btn) return;
          state.seriesKey = btn.dataset.series;
          render();
        });

        render();
      });
  </script>
</body>
</html>`;
}
