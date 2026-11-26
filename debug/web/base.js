// What every screen uses: elements, server calls, formats and the parts of the overviews.
"use strict";
const $ = (selector) => document.querySelector(selector);

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  // The server answers a path it does not know with "not found": its code is older than this page.
  const outdated = response.status === 404 && data.error === "not found";
  const message = outdated ? "The running server is older than this page: stop make debug (Ctrl+C) and start it again." : data.error || `HTTP ${response.status}`;
  if (!response.ok) throw Object.assign(new Error(message), { data });
  return data;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const fmtSeconds = (s) => s == null ? "–" : s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
const fmtClock = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const ORIGIN_LABEL = { seed: "Search result", cited: "Cited", dropped: "Dropped" };

function urlFor(id) {
  if (!id) return null;
  const [source, ...rest] = id.split(":");
  const native = rest.join(":");
  if (source === "pubmed") return `https://pubmed.ncbi.nlm.nih.gov/${native}/`;
  if (source === "arxiv") return `https://arxiv.org/abs/${native}`;
  if (source === "zenodo") return `https://zenodo.org/records/${native}`;
  if (source === "youtube") return `https://www.youtube.com/watch?v=${native}`;
  return null;
}

// Delete buttons ask once more: the first click arms them, a second click within 3 s deletes.
function armOrRun(button, label, action) {
  if (button.dataset.armed) { action(); return; }
  const original = button.textContent;
  button.dataset.armed = "1";
  button.textContent = label;
  button.classList.add("armed");
  setTimeout(() => {
    delete button.dataset.armed;
    button.textContent = original;
    button.classList.remove("armed");
  }, 3000);
}

const LOG_LIMIT = 4000;
function card(label, value, cls) { return h("div", { class: `card ${cls || ""}` }, h("b", {}, value ?? "–"), h("span", {}, label)); }

// ── Loading: answers from a large database take time, and the screen says so ───
// Nothing changes for a quick answer: a note fades in after a moment, and a busy mark is set only
// once a load takes longer than 200 ms. What loads for the first time shows a note in its place;
// what loads again keeps its content, faded under a spinner; a refresh in the background only
// turns the icon of its Refresh button.
const spinner = () => h("span", { class: "spinner", "aria-hidden": "true" });
const loadingNote = (text) => h("div", { class: "loading", role: "status" }, spinner(), h("span", {}, text));
const loadingRow = (columns, text) => h("tr", { class: "loading-row" }, h("td", { colspan: columns }, loadingNote(text)));
const BUSY = new WeakMap();
async function busy(node, work, cls) {
  if (!node) return work;
  const mark = BUSY.get(node) || { count: 0, timer: 0 };
  BUSY.set(node, mark);
  if (!mark.count++) mark.timer = setTimeout(() => { node.classList.add(cls); node.setAttribute("aria-busy", "true"); }, 200);
  try {
    return await work;
  } finally {
    if (!--mark.count) {
      clearTimeout(mark.timer);
      node.classList.remove(cls);
      node.removeAttribute("aria-busy");
    }
  }
}
// The content area of a screen (.content) while `work` runs: its lists fade under a spinner.
const busyArea = (node, work) => busy(node, work, "reloading");
// A Refresh button or an action button while `work` runs: a spinner in place of its icon.
const busyButton = (button, work) => busy(button, work, "spinning");

// Overviews above the tabs (.stats.overview): a total stands above what it splits into, so no part
// reads as a total of its own. A bar is a share of its group's total, in the colour of what it
// counts (an origin or a state), else graphite.
// `display` replaces the count, e.g. for gigabytes; a share above the total fills the bar.
function ovShare(label, count, total, { unit = "documents", color = null, sub = false, tip = null, onclick = null, display = null, percent = true } = {}) {
  const value = count ?? 0;
  const link = Boolean(onclick && value);
  return h("div", {
    class: `ov-row${value ? "" : " zero"}${sub ? " sub" : ""}${link ? " link" : ""}`,
    title: [display ? `${label}: ${display}` : `${label}: ${fmtCount(value)} of ${fmtCount(total)} ${unit}`, tip, link ? "Click to show them" : null].filter(Boolean).join("\n"),
    onclick: link ? onclick : null,
  },
    h("span", {}, label),
    h("span", { class: "ov-track" }, value && total ? h("i", { style: `width:${Math.min(100, (100 * value) / total)}%${color ? `;--bar:var(${color})` : ""}` }) : null),
    h("span", { class: "ov-value" }, display ?? fmtCount(value), percent ? h("small", {}, fmtShare(value, total)) : null));
}
function ovFigure(value, label, { cls = "", title = null, onclick = null } = {}) {
  return h("div", { class: `ov-row ${cls}${onclick ? " link" : ""}`, title, onclick }, h("b", {}, value), h("span", {}, label));
}
function ovSection(title, ...children) { return h("section", { class: "ov" }, h("h3", {}, title), ...children); }
// figures: true for counts, which align right so their digits line up; "words" for words and times, which align left
function ovList(rows, figures = false) { return h("div", { class: `ov-list${figures ? " figures" : ""}${figures === "words" ? " words" : ""}` }, ...rows); }

const typeLabel = (contentType) => contentType ? contentType.replace("_", " ") : "";
const fmtDuration = (seconds) => `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)} h ` : ""}${Math.floor((seconds % 3600) / 60)} min ${seconds % 60} s`;
const fmtBytes = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function authorList(authors) {
  const shown = authors.slice(0, 8).map((author, index) => [
    index ? ", " : "",
    author.name,
    author.orcid ? h("a", { href: `https://orcid.org/${author.orcid}`, target: "_blank", rel: "noopener", title: author.affiliation || "ORCID" }, " ⓘ") : null,
  ]);
  return h("span", {}, ...shown.flat(), authors.length > 8 ? ` … (+${authors.length - 8})` : "");
}

function externalLink(key, value) {
  const links = {
    pmcid: `https://pmc.ncbi.nlm.nih.gov/articles/${value}/`,
    concept_doi: `https://doi.org/${value}`,
    channel_id: `https://www.youtube.com/channel/${value}`,
  };
  return links[key] ? h("a", { href: links[key], target: "_blank", rel: "noopener" }, value) : value;
}

// A found_by query is a search, or for these sources the channel or feed key.
function seedKind(source) { return { youtube: "Channel", podcast: "Feed" }[source] || "Search"; }

function shellQuote(value) { return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`; }

// ── Shared by the Database, Index and Matcher screens ─────────────────────────
const fmtCount = (value) => Number(value).toLocaleString("en-GB");
const fmtCompact = (value) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const fmtShare = (count, total) => total ? `${Math.round((100 * count) / total)} %` : "–";
// What the keyword indexer did with a document's full text (`full_text_state` in server.py):
// the first two are done, the next run reads the others. [pill class, tip, label]
const FULL_TEXT_STATES = {
  indexed: ["ok", "Done: the keywords of its full text are in the index, beside its metadata", "fully indexed"],
  skipped: ["plain", "Done: no usable full text, so at most its metadata is matched", "metadata only"],
  failed: ["failed", "Open: the download failed, so at most its metadata is matched until the next run tries again", "retry download"],
  new: ["none", "Open: not read yet; the next run reads it", "new"],
  changed: ["none", "Open: changed since it was read; the next run reads it again", "changed"],
};

function fullTextPill(state) {
  const [cls, tip, label = state] = FULL_TEXT_STATES[state] || ["plain", ""];
  return h("span", { class: `pill ${cls}`, title: tip }, label);
}

// Named bars with their figure at the end. Rows: { name, value, label, title, onclick }.
function barList(rows, nameWidth) {
  const top = Math.max(1, ...rows.map((row) => row.value));
  return h("div", { class: "bars", style: nameWidth ? `--name-width:${nameWidth}px` : null }, ...rows.map((row) => h("div", { class: `bar-row${row.onclick ? " link" : ""}`, title: row.title, onclick: row.onclick },
    h("span", { class: "bar-name" }, row.name),
    h("span", { class: "bar-track" }, row.value > 0 ? h("i", { style: `width:${Math.max(0.6, (100 * row.value) / top)}%` }) : null),
    h("span", { class: "bar-value" }, row.label ?? fmtCount(row.value)))));
}

const SOURCE_LABEL = { pubmed: "PubMed", arxiv: "arXiv", zenodo: "Zenodo", youtube: "YouTube", podcast: "Podcast" };
const sourcePill = (source) => h("span", { class: `pill src-${source}` }, SOURCE_LABEL[source] || source);
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–";
function fmtSpan(ms) {
  const seconds = Math.abs(ms) / 1000;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

function fmtAgo(iso) {
  if (!iso) return "–";
  const ms = Date.now() - new Date(iso);
  return ms < 10000 ? "just now" : `${fmtSpan(ms)} ago`;
}

function queryString(values) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== "" && value != null) search.set(key, value);
  return search.toString();
}

function messageRow(columns, text, cls = "small") {
  return h("tr", {}, h("td", { colspan: columns, class: cls }, text));
}
