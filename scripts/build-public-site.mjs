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
  locales[locale.code] = {
    code: locale.code,
    label: locale.label,
    total: entries.length,
    models: entries.filter((entry) => entry.kind === "model").length,
    directories: entries.filter((entry) => entry.kind === "directory").length,
    entries
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
  const afterProducts = parts.slice(2);
  const last = afterProducts.at(-1) || "";
  const depth = parts.length;
  const kind = depth >= 6 ? "model" : "directory";
  return {
    locale: locale.code,
    url,
    depth,
    kind,
    slug: last,
    name: displayName(locale.code, afterProducts),
    path: afterProducts
  };
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
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px;
      display: grid;
      grid-template-columns: 330px 1fr;
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
      color: white;
      border-color: var(--brand);
    }
    input, select {
      width: 100%;
      padding: 11px 12px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: white;
      font: inherit;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      background: white;
    }
    .card a {
      color: var(--accent);
      text-decoration: none;
      word-break: break-all;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin: 16px 0;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: white;
    }
    .count { font-size: 22px; font-weight: 700; }
    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel">
      <h1>Hikvision Full Product Catalog</h1>
      <p class="muted">Public full catalog generated from Hikvision public sitemaps. This page focuses on complete product coverage first.</p>
      <div class="hero">
        <div class="badge">Full Catalog</div>
        <p id="updated" class="muted"></p>
      </div>
      <h3>Language</h3>
      <div class="tabs">
        <button class="active" data-locale="cn">中文</button>
        <button data-locale="en">English</button>
      </div>
      <h3 style="margin-top:18px;">Search</h3>
      <input id="search" placeholder="Search model / slug / path">
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
      </div>
      <div id="results" class="grid"></div>
    </main>
  </div>
  <script>
    const state = { locale: 'cn', kind: 'all', query: '' };
    const updated = document.getElementById('updated');
    const total = document.getElementById('total');
    const models = document.getElementById('models');
    const directories = document.getElementById('directories');
    const results = document.getElementById('results');

    fetch('./catalog.json')
      .then(r => r.json())
      .then(data => {
        updated.textContent = 'Updated: ' + new Date(data.generatedAt).toLocaleString();
        const render = () => {
          const locale = data.locales[state.locale];
          total.textContent = locale.total.toLocaleString();
          models.textContent = locale.models.toLocaleString();
          directories.textContent = locale.directories.toLocaleString();
          const q = state.query.trim().toLowerCase();
          let entries = locale.entries;
          if (state.kind !== 'all') entries = entries.filter(e => e.kind === state.kind);
          if (q) entries = entries.filter(e => [e.name, e.slug, e.path.join('/')].join(' ').toLowerCase().includes(q));
          const view = entries.slice(0, 500);
          results.innerHTML = view.map(entry => \`
            <article class="card">
              <div class="badge">\${entry.kind}</div>
              <h3>\${entry.name}</h3>
              <p class="muted">Depth: \${entry.depth} | Slug: \${entry.slug}</p>
              <p class="muted">\${entry.path.join(' / ')}</p>
              <a href="\${entry.url}" target="_blank" rel="noreferrer">\${entry.url}</a>
            </article>
          \`).join('');
        };

        document.querySelector('.tabs').addEventListener('click', (event) => {
          const btn = event.target.closest('button[data-locale]');
          if (!btn) return;
          state.locale = btn.dataset.locale;
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

        document.getElementById('search').addEventListener('input', (event) => {
          state.query = event.target.value;
          render();
        });

        render();
      });
  </script>
</body>
</html>`;
}
