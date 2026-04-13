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
  const sitemapEntries = [...xml.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?/g)].map((m) => ({
    url: m[1],
    lastmod: m[2] || ""
  }));
  const productEntries = sitemapEntries.filter((entry) => entry.url.includes(locale.prefix));
  const entries = productEntries.map((entry) => buildEntry(locale, entry));
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

function buildEntry(locale, sitemapEntry) {
  const parsed = new URL(sitemapEntry.url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const productPath = parts.slice(2);
  const slug = productPath.at(-1) || "";
  const kind = parts.length >= 6 ? "model" : "directory";
  return {
    locale: locale.code,
    url: sitemapEntry.url,
    lastmod: sitemapEntry.lastmod,
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
  <title>Hikvision Product Atlas</title>
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
      --accent-soft: #eef4f7;
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
    .tabs, .filters, .layout-tabs { display: flex; flex-wrap: wrap; gap: 10px; }
    button {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
      padding: 8px 14px;
      cursor: pointer;
      font: inherit;
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
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat, .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      background: #fff;
    }
    .count { font-size: 22px; font-weight: 700; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    .content-grid {
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 16px;
    }
    .card a { color: var(--accent); text-decoration: none; word-break: break-all; }
    .card a:hover { text-decoration: underline; }
    .tree ul { list-style: none; margin: 8px 0 0; padding-left: 18px; border-left: 1px solid var(--line); }
    .tree li { margin: 8px 0; position: relative; }
    .tree li::before { content: ""; position: absolute; left: -18px; top: 12px; width: 12px; border-top: 1px solid var(--line); }
    .series-list, .model-list, .diff-preview { max-height: 70vh; overflow: auto; display: grid; gap: 10px; }
    .series-item { width: 100%; text-align: left; border-radius: 14px; }
    .model-link, .preview-item {
      display: block;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      color: var(--accent);
      background: #fff;
      text-decoration: none;
    }
    .preview-item {
      color: var(--text);
      background: var(--accent-soft);
    }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: 14px; }
    th, td { border: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    th { background: #faf1e8; position: sticky; top: 0; }
    .scroll { overflow: auto; }
    @media (max-width: 980px) {
      .shell, .content-grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="panel">
      <h1>Hikvision Product Atlas</h1>
      <p class="muted">Public bilingual catalog with full series grouping, model lists, and specification differences.</p>
      <div class="hero">
        <div class="badge">Live Snapshot</div>
        <p id="updated" class="muted"></p>
        <p id="changeSummary" class="muted"></p>
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
        <div class="stat"><div class="muted">Changed Specs</div><div class="count" id="changedSpecs"></div></div>
      </div>
      <div id="changesPanel" class="grid" style="margin-bottom:16px;"></div>
      <div class="layout-tabs">
        <button class="active" data-view="catalog">Catalog</button>
        <button data-view="series">Series</button>
        <button data-view="diffs">Diffs</button>
        <button data-view="tree">Tree</button>
      </div>
      <div id="content"></div>
    </main>
  </div>
  <script>
    const state = { locale: "cn", kind: "all", query: "", view: "catalog", seriesKey: null };
    const copy = {
      cn: {
        totalUrls: "总链接",
        models: "型号",
        directories: "目录",
        series: "系列",
        changedSpecs: "规格变更",
        updated: "更新时间",
        thisRun: "本次更新",
        added: "新增链接",
        removed: "移除链接",
        changed: "规格变更",
        tree: "产品树",
        depth: "层级",
        slug: "标识",
        noCatalog: "没有匹配到目录",
        noSeries: "没有匹配到系列",
        noData: "暂无差异数据",
        noDataHelp: "等待抓取更多规格后，这里会自动出现对比结果。",
        specCoverage: "规格覆盖",
        diffFields: "差异字段",
        diffPreview: "系列差异预览",
        openDiffs: "在 Diffs 中查看完整对比"
      },
      en: {
        totalUrls: "Total URLs",
        models: "Models",
        directories: "Directories",
        series: "Series",
        changedSpecs: "Changed Specs",
        updated: "Updated",
        thisRun: "This Run",
        added: "Added URLs",
        removed: "Removed URLs",
        changed: "Changed Specs",
        tree: "Product Tree",
        depth: "Depth",
        slug: "Slug",
        noCatalog: "No matching catalog entries found.",
        noSeries: "No matching series found.",
        noData: "No diff data yet",
        noDataHelp: "Collect more specs and this view will populate automatically.",
        specCoverage: "Spec coverage",
        diffFields: "Diff fields",
        diffPreview: "Series Diff Preview",
        openDiffs: "Open full comparison in Diffs"
      }
    };

    const updated = document.getElementById("updated");
    const changeSummary = document.getElementById("changeSummary");
    const total = document.getElementById("total");
    const models = document.getElementById("models");
    const directories = document.getElementById("directories");
    const seriesCount = document.getElementById("seriesCount");
    const changedSpecs = document.getElementById("changedSpecs");
    const changesPanel = document.getElementById("changesPanel");
    const content = document.getElementById("content");

    Promise.all([
      fetch("./catalog.json").then((r) => r.json()),
      fetch("./diff-data.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ]).then(([data, diffData]) => {
      const diffLocales = diffData?.locales || {};

      const t = (key) => copy[state.locale][key] || key;
      const formatDate = (value) => new Date(value).toLocaleString(state.locale === "cn" ? "zh-CN" : "en-US");
      const escapeHtml = (value) => String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));

      function renderTree(node) {
        const children = (node.children || []).map(renderTree).join("");
        const label = node.url ? '<a href="' + node.url + '" target="_blank" rel="noreferrer">' + escapeHtml(node.name) + "</a>" : escapeHtml(node.name);
        return "<li>" + label + (children ? "<ul>" + children + "</ul>" : "") + "</li>";
      }

      function renderChangeCards() {
        const changes = diffData?.changes || {};
        const cards = [
          { label: t("added"), value: changes.addedUrls || 0 },
          { label: t("removed"), value: changes.removedUrls || 0 },
          { label: t("changed"), value: changes.changedSpecs || 0 }
        ];
        changesPanel.innerHTML = cards.map((card) => '<article class="card"><div class="muted">' + escapeHtml(card.label) + '</div><div class="count">' + Number(card.value).toLocaleString() + "</div></article>").join("");
        updated.textContent = t("updated") + ": " + formatDate(data.generatedAt);
        changeSummary.textContent = t("thisRun") + ": +" + Number(changes.addedUrls || 0).toLocaleString() + " / -" + Number(changes.removedUrls || 0).toLocaleString() + " / " + t("changed") + " " + Number(changes.changedSpecs || 0).toLocaleString();
      }

      function render() {
        renderChangeCards();
        const locale = data.locales[state.locale];
        total.textContent = locale.total.toLocaleString();
        models.textContent = locale.models.toLocaleString();
        directories.textContent = locale.directories.toLocaleString();
        seriesCount.textContent = locale.seriesCount.toLocaleString();
        changedSpecs.textContent = Number(diffData?.changes?.changedSpecs || 0).toLocaleString();
        const q = state.query.trim().toLowerCase();

        if (state.view === "catalog") {
          let entries = locale.entries;
          if (state.kind !== "all") entries = entries.filter((entry) => entry.kind === state.kind);
          if (q) entries = entries.filter((entry) => [entry.name, entry.slug, entry.path.join("/")].join(" ").toLowerCase().includes(q));
          const view = entries.slice(0, 500);
          content.innerHTML = view.length
            ? '<div class="grid">' + view.map((entry) => '<article class="card"><div class="badge">' + escapeHtml(entry.kind) + '</div><h3>' + escapeHtml(entry.name) + '</h3><p class="muted">' + t("depth") + ": " + entry.depth + " | " + t("slug") + ": " + escapeHtml(entry.slug) + '</p><p class="muted">' + escapeHtml(entry.path.join(" / ")) + '</p><a href="' + entry.url + '" target="_blank" rel="noreferrer">' + escapeHtml(entry.url) + "</a></article>").join("") + "</div>"
            : '<div class="card"><h2>' + t("noCatalog") + "</h2></div>";
          return;
        }

        if (state.view === "tree") {
          content.innerHTML = '<div class="card tree"><h2>' + escapeHtml(locale.label) + " " + t("tree") + "</h2><ul>" + renderTree(locale.tree) + "</ul></div>";
          return;
        }

        if (state.view === "diffs") {
          let series = diffLocales[state.locale]?.topSeries || [];
          if (q) series = series.filter((item) => [item.name, ...item.models.map((model) => model.name)].join(" ").toLowerCase().includes(q));
          const selected = series.find((item) => item.key === state.seriesKey) || series[0];
          state.seriesKey = selected ? selected.key : null;
          const left = '<div class="series-list">' + series.map((item) => '<button class="series-item ' + (selected && item.key === selected.key ? "active" : "") + '" data-series="' + item.key + '">' + escapeHtml(item.name) + " (" + item.specCoverage + "/" + item.modelCount + ")</button>").join("") + "</div>";
          let right = '<div class="card"><h2>' + t("noData") + "</h2><p class=\"muted\">" + t("noDataHelp") + "</p></div>";
          if (selected) {
            const headers = selected.models.map((model) => "<th>" + escapeHtml(model.name) + "</th>").join("");
            const rows = selected.differences.length
              ? selected.differences.map((diff) => "<tr><td>" + escapeHtml(diff.field) + "</td>" + selected.models.map((model) => "<td>" + escapeHtml(diff.values[model.name] || "") + "</td>").join("") + "</tr>").join("")
              : "<tr><td colspan=\"" + (selected.models.length + 1) + "\">" + t("noData") + "</td></tr>";
            right = '<div class="card"><div class="badge">diffs</div><h2>' + escapeHtml(selected.name) + '</h2><p class="muted">' + t("specCoverage") + ": " + selected.specCoverage + " / " + selected.modelCount + " | " + t("diffFields") + ": " + selected.differences.length + '</p><p><a href="' + selected.url + '" target="_blank" rel="noreferrer">' + escapeHtml(selected.url) + '</a></p><div class="scroll"><table><thead><tr><th>Field</th>' + headers + "</tr></thead><tbody>" + rows + "</tbody></table></div></div>";
          }
          content.innerHTML = '<div class="content-grid">' + left + right + "</div>";
          return;
        }

        let series = locale.series;
        if (q) series = series.filter((item) => [item.name, item.path.join("/"), ...item.models.map((model) => model.name)].join(" ").toLowerCase().includes(q));
        const selected = series.find((item) => item.key === state.seriesKey) || series[0];
        state.seriesKey = selected ? selected.key : null;
        const left = '<div class="series-list">' + series.slice(0, 500).map((item) => '<button class="series-item ' + (selected && item.key === selected.key ? "active" : "") + '" data-series="' + item.key + '">' + escapeHtml(item.name) + " (" + item.modelCount + ")</button>").join("") + "</div>";
        let right = '<div class="card"><h2>' + t("noSeries") + "</h2></div>";
        if (selected) {
          const selectedDiff = (diffLocales[state.locale]?.topSeries || []).find((item) => item.key === selected.key);
          const preview = selectedDiff
            ? '<div class="card" style="margin-top:14px;"><div class="badge">diffs</div><h3>' + t("diffPreview") + '</h3><p class="muted">' + t("specCoverage") + ": " + selectedDiff.specCoverage + " / " + selectedDiff.modelCount + " | " + t("diffFields") + ": " + selectedDiff.differences.length + '</p><div class="diff-preview">' + selectedDiff.differences.slice(0, 8).map((diff) => '<div class="preview-item"><strong>' + escapeHtml(diff.field) + '</strong><br><span class="muted">' + Object.entries(diff.values).slice(0, 2).map(([name, value]) => escapeHtml(name) + ": " + escapeHtml(value)).join(" | ") + "</span></div>").join("") + '</div><p style="margin-top:12px;"><button data-open-diffs="true">' + t("openDiffs") + "</button></p></div>"
            : "";
          right = '<div><div class="card"><div class="badge">series</div><h2>' + escapeHtml(selected.name) + '</h2><p class="muted">' + t("models") + ": " + selected.modelCount + '</p><p class="muted">' + escapeHtml(selected.path.join(" / ")) + '</p><p><a href="' + selected.url + '" target="_blank" rel="noreferrer">' + escapeHtml(selected.url) + '</a></p><div class="model-list">' + selected.models.slice(0, 1000).map((model) => '<a class="model-link" href="' + model.url + '" target="_blank" rel="noreferrer">' + escapeHtml(model.name) + "</a>").join("") + "</div></div>" + preview + "</div>";
        }
        content.innerHTML = '<div class="content-grid">' + left + right + "</div>";
      }

      document.querySelector(".tabs").addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-locale]");
        if (!btn) return;
        state.locale = btn.dataset.locale;
        state.seriesKey = null;
        document.querySelectorAll(".tabs button").forEach((button) => button.classList.toggle("active", button === btn));
        render();
      });

      document.querySelector(".filters").addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-kind]");
        if (!btn) return;
        state.kind = btn.dataset.kind;
        document.querySelectorAll(".filters button").forEach((button) => button.classList.toggle("active", button === btn));
        render();
      });

      document.querySelector(".layout-tabs").addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-view]");
        if (!btn) return;
        state.view = btn.dataset.view;
        document.querySelectorAll(".layout-tabs button").forEach((button) => button.classList.toggle("active", button === btn));
        render();
      });

      document.getElementById("search").addEventListener("input", (event) => {
        state.query = event.target.value;
        render();
      });

      content.addEventListener("click", (event) => {
        const seriesButton = event.target.closest("button[data-series]");
        if (seriesButton) {
          state.seriesKey = seriesButton.dataset.series;
          render();
          return;
        }
        const diffButton = event.target.closest("button[data-open-diffs]");
        if (diffButton) {
          state.view = "diffs";
          document.querySelectorAll(".layout-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.view === "diffs"));
          render();
        }
      });

      render();
    });
  </script>
</body>
</html>`;
}
