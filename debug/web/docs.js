"use strict";
// ── Docs screen: every Markdown file of the checkout as a tree, rendered, with search ──
// The hash is #doc/<path>#<anchor>; links between docs stay on this screen, Back goes back.
const DC_HOME = "Documentation/README.md";
const DC_REPO = "https://github.com/amosproj/amos2026ws03-patient-journey-matcher";
const dc = {
  docs: null, folders: new Set(), error: null, refreshedAt: 0,
  current: null, shown: null, view: "page", headings: [], outline: [], scrollTop: 0,
  query: "", results: [], active: 0, typing: 0,
  terms: null, marks: [], mark: -1,
  open: new Set(dcStored("docs-open", ["Documentation"])),
  labels: dcStored("docs-labels", "titles") === "files" ? "files" : "titles",
};

function dcStored(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; }
}
function dcStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* no storage: lasts until the page reloads */ }
}

const dcDecode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
const dcHash = (path, anchor = null) => `#doc/${path.split("/").map(encodeURIComponent).join("/")}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
const dcFileUrl = (path) => `/api/docs/file?path=${encodeURIComponent(path)}`;
const dcPlainClick = (event) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
const dcFolders = (path) => path.split("/").slice(0, -1).map((_, k, parts) => parts.slice(0, k + 1).join("/"));
// Search ignores case and accents: "jarvelin" finds "Järvelin".
const dcFold = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function dcFromHash() {
  const match = /^#doc(?:\/([^#]*))?(?:#(.*))?$/.exec(location.hash);
  return match ? { path: match[1] ? dcDecode(match[1]) : null, anchor: match[2] ? dcDecode(match[2]) : null } : null;
}

// ── Loading: the texts come from the server, everything else is worked out here ──
async function dcLoad() {
  const data = await api("/api/docs");
  const docs = new Map();
  for (const { path, text } of data.docs) {
    const known = dc.docs?.get(path);
    docs.set(path, known && known.text === text ? known : dcPrepare(path, text));
  }
  dc.docs = docs;
  dc.folders = new Set([...docs.keys()].flatMap(dcFolders));
  dc.refreshedAt = Date.now();
}

function dcPrepare(path, text) {
  const blocks = mdParse(text);
  const { entries, anchors } = dcEntries(blocks);
  const name = path.split("/").pop();
  const title = mdTitle(blocks) || entries.find((entry) => entry.kind === "heading")?.text
    || (name === "README.md" && path.includes("/") ? path.split("/").at(-2) : name.replace(/\.md$/i, ""));
  return { path, text, blocks, title, entries, anchors, foldedTitle: dcFold(title), foldedPath: dcFold(path), foldedName: dcFold(name) };
}

// What search looks through: the text a reader sees, block by block, with the section it is in.
// The slugs come out as on the page, as both walk the headings in the same order.
function dcEntries(blocks) {
  const entries = [], anchors = new Set(), slug = mdSlugger();
  let section = null, anchor = null;
  const add = (block, kind, text, extra = {}) => {
    if (text.trim()) entries.push({ seq: block.seq, kind, text, folded: dcFold(text), section, anchor, ...extra });
  };
  const walk = (list) => {
    for (const block of list) {
      if (block.children) walk(block.children);
      else if (block.items) for (const item of block.items) walk(item.children);
      else if (block.type === "heading") {
        const nodes = mdInline(block.text);
        anchor = slug(mdPlain(nodes));
        section = mdPlain(nodes).trim();
        anchors.add(anchor);
        add(block, "heading", section);
      } else if (block.type === "paragraph") add(block, "text", mdPlain(mdInline(block.text)));
      else if (block.type === "code" || block.type === "math") block.text.split("\n").forEach((line, k) => add(block, "code", line, { line: k }));
      else if (block.type === "table") [block.head, ...block.rows].forEach((row, k) => add(block, "row", row.map((cell) => mdPlain(mdInline(cell))).join("  ·  "), { row: k }));
      else if (block.type === "html") {
        for (const match of block.html.matchAll(/\b(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
        add(block, "text", new DOMParser().parseFromString(block.html, "text/html").body.textContent.replace(/\s+/g, " "));
      }
    }
  };
  walk(blocks);
  return { entries, anchors };
}

// ── The screen ────────────────────────────────────────────────────────────────
async function dcShow() {
  const target = dcFromHash();
  if (!dc.docs) {
    $("#doc-article").replaceChildren(loadingNote("Loading the docs …"));
    try {
      await dcLoad();
      dc.error = null;
    } catch (error) {
      dc.error = error.message;
    }
  }
  if (state.screen !== "doc") return;
  dcRenderCount();
  if (!dc.docs) {
    dcRenderTree();
    $("#doc-bar").replaceChildren();
    $("#doc-article").replaceChildren(h("div", { class: "notice" }, `The docs could not be loaded: ${dc.error}`));
    return;
  }
  const path = target?.path || dc.current || DC_HOME;
  // Back from another screen, or Docs clicked again: the reader stays where they were.
  dcOpen(path, target?.anchor ?? null, { push: false, scroll: path === dc.current && dc.shown ? dc.scrollTop : null });
}

async function dcRefresh() {
  try {
    await busyButton($("#doc-refresh"), dcLoad());
    dc.error = null;
  } catch (error) {
    dc.error = error.message;
    return;
  }
  dcRenderCount();
  if (dc.query.trim()) dc.results = dcSearch(dc.query);
  dcRenderTree();
  const doc = dc.docs.get(dc.current);
  if (!doc && dc.shown) dcOpen(dc.current, null, { push: false }); // its file is gone
  else if (doc && doc !== dc.shown) { // its file changed: draw it again where the reader is
    const top = $("#doc-scroll").scrollTop, terms = dc.terms;
    dcClearMarks();
    dcRender(doc);
    $("#doc-scroll").scrollTop = top;
    if (terms) dcFind(terms, null, false);
  }
}

function dcRenderCount() {
  $("#doc-count").textContent = dc.docs ? plural(dc.docs.size, "doc") : "";
  for (const button of document.querySelectorAll("#doc-labels button")) button.classList.toggle("active", button.dataset.value === dc.labels);
}

// Opens a doc; `push` adds a history entry, `terms` highlights a search, `hit` is the entry clicked.
function dcOpen(path, anchor = null, { push = true, terms = null, hit = null, scroll = null } = {}) {
  const scroller = $("#doc-scroll");
  dcKeep(null);
  if (push && dc.current) history.replaceState({ ...(history.state || {}), dcScroll: scroller.scrollTop }, "");
  const doc = dc.docs.get(path);
  dc.current = path;
  for (const folder of dcFolders(path)) dc.open.add(folder);
  dcStore("docs-open", [...dc.open]);
  dcClearMarks();
  const url = dcHash(path, anchor);
  if (dcDecode(location.hash) !== dcDecode(url)) {
    if (push) history.pushState({ dcScroll: 0 }, "", url);
    else history.replaceState(history.state, "", url);
  }
  dcRenderTree();
  dcRevealRow(path);
  if (!doc) {
    dc.shown = null;
    $("#doc-bar").replaceChildren();
    $("#doc-outline").replaceChildren();
    $("#doc-outline").parentElement.classList.add("no-outline");
    $("#doc-article").replaceChildren(h("div", { class: "notice" }, `There is no doc ${path} in this checkout.`));
    return;
  }
  if (doc !== dc.shown) dcRender(doc);
  if (terms?.length) dcFind(terms, hit);
  else if (scroll != null) scroller.scrollTop = scroll;
  else if (!anchor || !dcScrollTo(anchor, false)) scroller.scrollTop = 0;
}

function dcRender(doc) {
  dc.shown = doc;
  dc.headings = [];
  const article = $("#doc-article");
  if (dc.view === "source") {
    article.className = "dc-source";
    article.replaceChildren(...doc.text.split("\n").map((line, k) => h("div", { class: "dc-line" }, h("span", { class: "dc-ln", "data-n": k + 1, "aria-hidden": "true" }), line)));
  } else {
    article.className = "md";
    const ctx = { link: (href) => dcLink(doc.path, href), image: (src) => dcImage(doc.path, src), slug: mdSlugger(), headings: dc.headings, anchorHref: (anchor) => dcHash(doc.path, anchor) };
    article.replaceChildren(...mdBuild(doc.blocks, ctx).filter(Boolean));
  }
  dcRenderBar(doc);
  dcRenderOutline();
}

// A link of a doc: another doc opens here, a file of the checkout on GitHub, the web in a new tab.
function dcLink(from, href) {
  const link = href.trim();
  if (!link) return null;
  if (link.startsWith("#")) return dcInternal(from, dcDecode(link.slice(1)));
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(link)?.[1].toLowerCase();
  if (scheme) {
    if (!["http", "https", "mailto"].includes(scheme)) return null;
    const own = link.startsWith(`${DC_REPO}/blob/`) && /^[^/]+\/([^?#]+)(?:#(.*))?$/.exec(link.slice(DC_REPO.length + 6));
    if (own && dc.docs.has(dcDecode(own[1]))) return dcInternal(dcDecode(own[1]), own[2] ? dcDecode(own[2]) : null);
    return { href: link, target: "_blank", rel: "noopener" };
  }
  const cut = link.search(/[?#]/);
  const target = dcResolve(from, cut < 0 ? link : link.slice(0, cut));
  const anchor = link.includes("#") ? dcDecode(link.slice(link.indexOf("#") + 1)) : null;
  if (dc.docs.has(target)) return dcInternal(target, anchor);
  const readme = target ? `${target}/README.md` : "README.md";
  if (dc.docs.has(readme)) return dcInternal(readme, anchor);
  if (/\.(?:png|jpe?g|gif|webp|svg|pdf)$/i.test(target)) return { href: dcFileUrl(target), target: "_blank", rel: "noopener" };
  if (/\.md$/i.test(target)) return { href: dcHash(target), class: "md-broken", title: `${target} is not in this checkout`, "data-doc": target };
  const folder = dc.folders.has(target) || /\/$/.test(cut < 0 ? link : link.slice(0, cut));
  return { href: `${DC_REPO}/${folder ? "tree" : "blob"}/main/${target}`, target: "_blank", rel: "noopener", title: `${target} on GitHub` };
}

function dcInternal(path, anchor) {
  const missing = Boolean(anchor) && !dc.docs.get(path)?.anchors.has(anchor);
  return {
    href: dcHash(path, anchor), "data-doc": path, "data-anchor-target": anchor,
    class: missing ? "md-broken" : null, title: missing ? `No heading #${anchor} in ${path}` : null,
  };
}

function dcImage(from, src) {
  const link = src.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(link)?.[1].toLowerCase();
  if (scheme) return scheme === "https" || scheme === "http" ? link : null;
  return dcFileUrl(dcResolve(from, link.split(/[?#]/)[0]));
}

// A link target relative to the doc; GitHub reads a leading "/" as the repository root.
function dcResolve(from, target) {
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(dcDecode(part));
  }
  return parts.join("/");
}

function dcRenderBar(doc) {
  const parts = doc.path.split("/");
  const crumbs = parts.flatMap((part, k) => [
    k ? h("span", { class: "dc-sep", "aria-hidden": "true" }, "/") : null,
    k < parts.length - 1
      ? h("button", { type: "button", class: "dc-crumb", title: "Show in the tree", onclick: () => dcReveal(parts.slice(0, k + 1).join("/")) }, part)
      : h("b", { class: "dc-crumb", title: doc.path }, part),
  ]);
  const view = (value, label, title) => h("button", { type: "button", class: dc.view === value ? "active" : null, title, onclick: () => dcSetView(value) }, label);
  $("#doc-bar").replaceChildren(
    h("nav", { class: "dc-crumbs", "aria-label": "Path" }, ...crumbs),
    h("div", { class: "dc-find", id: "doc-find", role: "status", hidden: true }),
    h("div", { class: "mini-seg", role: "group", "aria-label": "Show the doc" }, view("page", "Page", "As GitHub shows it"), view("source", "Markdown", "The file as it is, with line numbers")),
    h("a", { class: "dc-tool", href: `${DC_REPO}/blob/main/${doc.path}`, target: "_blank", rel: "noopener", title: "This doc on GitHub, on the main branch" }, "GitHub ↗"));
}

function dcSetView(view) {
  if (dc.view === view) return;
  const terms = dc.terms;
  dc.view = view;
  dcClearMarks();
  if (dc.shown) dcRender(dc.shown);
  $("#doc-scroll").scrollTop = 0;
  if (terms) dcFind(terms, null);
}

// ── Outline: the sections of the doc, the one in view marked ──────────────────
function dcRenderOutline() {
  const nav = $("#doc-outline"), headings = dc.headings;
  const top = Math.min(...headings.map((heading) => heading.level));
  const from = headings.filter((heading) => heading.level === top).length === 1 ? top + 1 : top; // below a single title
  const shown = headings.filter((heading) => heading.level >= from && heading.level <= from + 1);
  const article = $("#doc-article");
  dc.outline = shown.length < 2 ? [] : shown.map((heading) => ({
    heading: article.querySelector(`[data-anchor="${CSS.escape(heading.anchor)}"]`),
    link: h("a", { href: dcHash(dc.current, heading.anchor), "data-outline": heading.anchor, title: heading.text }, heading.text),
    sub: heading.level > from,
  }));
  nav.replaceChildren(...(dc.outline.length ? [h("h4", {}, "On this page"), h("ul", {}, ...dc.outline.map((item) => h("li", { class: item.sub ? "sub" : null }, item.link)))] : []));
  nav.parentElement.classList.toggle("no-outline", !dc.outline.length);
  dcSpy();
}

function dcSpy() {
  dc.spyFrame = 0;
  if (!dc.outline.length) return;
  const scroller = $("#doc-scroll");
  const line = scroller.getBoundingClientRect().top + 96;
  let active = dc.outline[0];
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) active = dc.outline.at(-1);
  else for (const item of dc.outline) { if (item.heading && item.heading.getBoundingClientRect().top <= line) active = item; else break; }
  for (const item of dc.outline) item.link.classList.toggle("active", item === active);
}

function dcScrollTo(anchor, smooth) {
  const target = $("#doc-article").querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
  if (!target) return false;
  target.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  dcKeep(target, "start");
  dcFlash(target);
  return true;
}

// Images that load after a jump can push its target out of view: until the reader scrolls, or
// for 5 s, the target is brought back each time the doc changes its size.
function dcKeep(node, block) { dc.keep = node ? { node, block, until: performance.now() + 5000 } : null; }
new ResizeObserver(() => {
  const keep = dc.keep;
  if (!keep) return;
  if (!keep.node.isConnected || performance.now() > keep.until) dc.keep = null;
  else keep.node.scrollIntoView({ block: keep.block });
}).observe($("#doc-article"));

function dcFlash(node) {
  if (!node) return;
  node.classList.remove("dc-flash");
  void node.offsetWidth; // restarts the animation
  node.classList.add("dc-flash");
}

// ── Tree ──────────────────────────────────────────────────────────────────────
function dcRenderTree() {
  const nav = $("#doc-tree");
  if (dc.query.trim() && dc.docs) { dcRenderResults(); return; }
  if (!dc.docs) { nav.replaceChildren(dc.error ? h("div", { class: "dc-empty" }, "No docs") : loadingNote("Loading …")); return; }
  const root = { path: "", folders: new Map(), files: [] };
  for (const doc of dc.docs.values()) {
    let node = root;
    for (const folder of dcFolders(doc.path)) {
      const name = folder.split("/").pop();
      if (!node.folders.has(name)) node.folders.set(name, { name, path: folder, folders: new Map(), files: [] });
      node = node.folders.get(name);
    }
    node.files.push(doc);
  }
  nav.replaceChildren(h("ul", { class: "dc-tree" }, ...dcTreeItems(root, true)));
}

const dcLabel = (doc) => (dc.labels === "files" ? doc.path.split("/").pop() : doc.title);
const dcIsReadme = (doc) => /(^|\/)README\.md$/i.test(doc.path);
const dcCountDocs = (folder) => folder.files.length + [...folder.folders.values()].reduce((sum, sub) => sum + dcCountDocs(sub), 0);

// Folders first, Documentation on top; a folder's README before its other files. A folder that
// only holds one folder shares its row, as in VS Code: "graph/fixtures/pubtator".
function dcTreeItems(folder, top = false) {
  const byName = (a, b) => a.localeCompare(b, "en", { sensitivity: "base" });
  const folders = [...folder.folders.values()].sort((a, b) => (top ? (b.name === "Documentation") - (a.name === "Documentation") : 0) || byName(a.name, b.name));
  const files = [...folder.files].sort((a, b) => dcIsReadme(b) - dcIsReadme(a) || byName(dcLabel(a), dcLabel(b)));
  return [
    ...folders.map((sub) => {
      let node = sub, name = sub.name;
      while (!node.files.length && node.folders.size === 1) {
        node = node.folders.values().next().value;
        name += `/${node.name}`;
      }
      const open = dc.open.has(node.path);
      return h("li", { class: `dc-folder${open ? " open" : ""}` },
        h("button", { type: "button", class: "dc-row", "data-folder": node.path, "aria-expanded": String(open), title: node.path, onclick: () => dcToggle(node.path) },
          h("i", { class: "dc-chevron", "aria-hidden": "true" }), h("i", { class: "dc-icon dc-folder-icon", "aria-hidden": "true" }),
          h("span", { class: "dc-name" }, name), h("small", {}, dcCountDocs(node))),
        open ? h("ul", {}, ...dcTreeItems(node)) : null);
    }),
    ...files.map((doc) => h("li", {}, dcFileRow(doc))),
  ];
}

function dcFileRow(doc) {
  const name = doc.path.split("/").pop();
  const active = doc.path === dc.current;
  return h("a", {
    class: `dc-row dc-file${active ? " active" : ""}`, href: dcHash(doc.path), "data-path": doc.path,
    "aria-current": active ? "page" : null, title: dc.labels === "files" ? doc.title : doc.path,
    onclick: (event) => { if (dcPlainClick(event)) { event.preventDefault(); dcOpen(doc.path); dcHideSideOnPhones(); } },
  },
  h("i", { class: "dc-icon dc-file-icon", "aria-hidden": "true" }),
  h("span", { class: "dc-name" }, ...(dc.labels === "files" ? [name.replace(/\.md$/i, ""), h("span", { class: "dc-ext" }, ".md")] : [doc.title])));
}

function dcToggle(path) {
  if (dc.open.has(path)) {
    for (const open of [...dc.open]) if (open === path || open.startsWith(`${path}/`)) dc.open.delete(open);
  } else dc.open.add(path);
  dcStore("docs-open", [...dc.open]);
  dcRenderTree();
}

function dcRevealRow(path) {
  const row = [...document.querySelectorAll("#doc-tree [data-path]")].find((node) => node.dataset.path === path);
  row?.scrollIntoView({ block: "nearest" });
}

// From the path above the doc: opens the folder in the tree and points at it.
function dcReveal(folder) {
  setControlsVisible(true);
  if (dc.query) { $("#doc-search").value = ""; dcRunSearch(); }
  const find = () => [...document.querySelectorAll("#doc-tree [data-folder]")].find((node) => node.dataset.folder === folder || node.dataset.folder.startsWith(`${folder}/`));
  for (const path of dcFolders(`${folder}/x`)) dc.open.add(path);
  dcRenderTree();
  const shared = find()?.dataset.folder; // a row the folder shares with the one folder below it
  if (shared) dc.open.add(shared);
  dcStore("docs-open", [...dc.open]);
  dcRenderTree();
  const row = find();
  row?.scrollIntoView({ block: "nearest" });
  dcFlash(row);
}

function dcHideSideOnPhones() { if (narrowScreen.matches) setControlsVisible(false); }

// ── Search ────────────────────────────────────────────────────────────────────
const dcTerms = (query) => [...new Set(dcFold(query).split(/\s+/).filter(Boolean))];
const DC_WORD = /[\p{L}\p{N}]/u;

// Where a term starts a word, as docs searches match: "rank" finds "ranks", not "reranking".
// A term that starts with a sign, such as ".json", matches anywhere.
function dcFindAll(folded, term) {
  const found = [], anywhere = !DC_WORD.test(term[0]);
  for (let at = folded.indexOf(term); at >= 0;) {
    if (anywhere || at === 0 || !DC_WORD.test(folded[at - 1])) { found.push(at); at = folded.indexOf(term, at + term.length); }
    else at = folded.indexOf(term, at + 1);
  }
  return found;
}
const dcHas = (folded, term) => dcFindAll(folded, term).length > 0;

// Docs that contain every term somewhere, best first: a term in the title or file name counts
// most, then the terms as typed, then headings; many hits count, but only by their logarithm,
// so the long legal notices do not come first for every word.
function dcSearch(query) {
  const terms = dcTerms(query);
  if (!terms.length) return [];
  const phrase = terms.length > 1 ? dcFold(query).trim().split(/\s+/).join(" ") : null;
  const results = [];
  for (const doc of dc.docs.values()) {
    const hits = [];
    for (const entry of doc.entries) {
      let found = 0, count = 0;
      for (const term of terms) {
        const n = dcFindAll(entry.folded, term).length;
        if (n) { found++; count += n; }
      }
      if (found) hits.push({ entry, found, count, phrase: Boolean(phrase) && found === terms.length && entry.folded.includes(phrase) });
    }
    if (!terms.every((term) => dcHas(doc.foldedTitle, term) || dcHas(doc.foldedPath, term) || hits.some((hit) => dcHas(hit.entry.folded, term)))) continue;
    let score = 0;
    for (const term of terms) score += (dcHas(doc.foldedTitle, term) ? 30 : 0) + (dcHas(doc.foldedName, term) ? 10 : dcHas(doc.foldedPath, term) ? 4 : 0);
    score += 12 * Math.min(3, hits.filter((hit) => hit.phrase).length);
    score += 8 * Math.min(3, hits.filter((hit) => hit.entry.kind === "heading").length);
    score += 3 * Math.min(10, hits.filter((hit) => hit.found === terms.length).length);
    score += 4 * Math.log2(1 + hits.reduce((sum, hit) => sum + hit.count, 0));
    hits.sort((a, b) => b.phrase - a.phrase || b.found - a.found || (b.entry.kind === "heading") - (a.entry.kind === "heading") || a.entry.seq - b.entry.seq);
    results.push({ doc, score, hits: hits.slice(0, 3), total: hits.length });
  }
  return results.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
}

function dcRunSearch() {
  dc.query = $("#doc-search").value;
  dc.results = dc.docs && dc.query.trim() ? dcSearch(dc.query) : [];
  dc.active = 0;
  dcRenderTree();
  $("#doc-tree").scrollTop = 0;
}

function dcRenderResults() {
  const nav = $("#doc-tree"), terms = dcTerms(dc.query);
  const phrase = terms.length > 1 ? dcFold(dc.query).trim().split(/\s+/).join(" ") : null;
  if (!dc.results.length) { nav.replaceChildren(h("div", { class: "dc-empty" }, `No doc contains “${dc.query.trim()}”.`)); return; }
  nav.replaceChildren(
    h("div", { class: "dc-results-head" }, `${plural(dc.results.length, "doc")} · ↑↓ and Enter to open`),
    ...dc.results.map((result, k) => h("div", { class: `dc-result${k === dc.active ? " active" : ""}` },
      h("a", { class: "dc-result-head", href: dcHash(result.doc.path), onclick: (event) => dcOpenResult(event, result, null) },
        h("b", {}, ...dcHighlight(result.doc.title, terms)), h("small", {}, ...dcHighlight(result.doc.path, terms))),
      ...result.hits.map((hit) => h("a", { class: "dc-result-hit", href: dcHash(result.doc.path, hit.entry.anchor), onclick: (event) => dcOpenResult(event, result, hit) },
        hit.entry.kind !== "heading" && hit.entry.section ? h("span", { class: "dc-result-section" }, hit.entry.section) : null,
        h("span", { class: `dc-result-text${hit.entry.kind === "code" ? " mono" : ""}` }, ...dcSnippet(hit.entry.text, terms, phrase)))),
      result.total > result.hits.length ? h("small", { class: "dc-result-more" }, `${fmtCount(result.total - result.hits.length)} more in this doc`) : null)));
}

function dcOpenResult(event, result, hit) {
  if (!dcPlainClick(event)) return;
  event.preventDefault();
  dc.active = dc.results.indexOf(result);
  const entry = hit?.entry ?? result.hits[0]?.entry ?? null;
  dcOpen(result.doc.path, entry?.anchor ?? null, { terms: dcTerms(dc.query), hit: entry });
  dcHideSideOnPhones();
}

// Positions in the folded text map back to the original, so marks fit whatever was folded.
function dcFoldMap(text) {
  let folded = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const part = dcFold(text[i]);
    folded += part;
    for (let k = 0; k < part.length; k++) map.push(i);
  }
  return { folded, map };
}

function dcRanges(text, terms) {
  const { folded, map } = dcFoldMap(text);
  const ranges = [];
  for (const term of terms) for (const at of dcFindAll(folded, term)) ranges.push([map[at], map[at + term.length - 1] + 1]);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function dcHighlight(text, terms, mark = () => h("mark", {})) {
  const out = [];
  let at = 0;
  for (const [start, end] of dcRanges(text, terms)) {
    if (start > at) out.push(text.slice(at, start));
    const node = mark();
    node.textContent = text.slice(start, end);
    out.push(node);
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// The text around the terms as typed, else around the first term found.
function dcSnippet(text, terms, phrase, room = 120) {
  let first = dcRanges(text, terms)[0]?.[0] ?? 0;
  if (phrase) {
    const { folded, map } = dcFoldMap(text);
    const at = folded.indexOf(phrase);
    if (at >= 0) first = map[at];
  }
  let start = Math.max(0, first - 40);
  if (start > 0) { const space = text.indexOf(" ", start); if (space >= 0 && space < first) start = space + 1; }
  const end = Math.min(text.length, start + room);
  return [start > 0 ? "…" : "", ...dcHighlight(text.slice(start, end), terms), end < text.length ? "…" : ""];
}

// ── Find on the page: the terms of a search, marked, with the hit clicked in view ──
function dcFind(terms, hit, jump = true) {
  const article = $("#doc-article");
  dc.terms = terms;
  dc.marks = dcMark(article, terms);
  dc.mark = -1;
  let target = hit ? article.querySelector(`[data-block="${hit.seq}"]`) : null;
  if (target && hit.row != null) target = target.querySelector("table")?.rows[hit.row] || target;
  let index = 0;
  if (target) { // in the hit's block: the mark where the terms stand as typed, else its first
    const own = dc.marks.filter((mark) => target.contains(mark) && (hit.line == null || dcLineOf(mark, target) >= hit.line));
    const phrase = terms.length > 1 ? dcPhraseAt(target, terms.join(" ")) : -1;
    const pick = (phrase >= 0 && own.find((mark) => dcOffset(mark, target) >= phrase)) || own[0];
    index = pick ? dc.marks.indexOf(pick) : -1;
  }
  if (jump && index >= 0 && dc.marks.length) { dc.mark = index; dcShowMark(); return; }
  if (jump && target) { target.scrollIntoView({ block: "center" }); dcKeep(target, "center"); dcFlash(target); } // the match spans an element: no mark
  dcRenderFind();
}

function dcMark(root, terms) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement.closest(".md-code-bar, .md-anchor, math") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const marks = [];
  for (const node of nodes) {
    const folded = dcFold(node.data);
    if (!terms.some((term) => dcHas(folded, term))) continue;
    node.replaceWith(...dcHighlight(node.data, terms, () => { const mark = h("mark", { class: "dc-mark" }); marks.push(mark); return mark; }));
  }
  return marks;
}

function dcOffset(node, root) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEndBefore(node);
  return range.toString().length;
}

function dcPhraseAt(root, phrase) {
  const { folded, map } = dcFoldMap(root.textContent);
  const at = folded.indexOf(phrase);
  return at >= 0 ? map[at] : -1;
}

function dcLineOf(mark, block) {
  const code = block.querySelector("code");
  if (!code?.contains(mark)) return 0;
  const range = document.createRange();
  range.setStart(code, 0);
  range.setEndBefore(mark);
  return range.toString().split("\n").length - 1;
}

function dcShowMark() {
  dc.marks.forEach((mark, k) => mark.classList.toggle("current", k === dc.mark));
  dc.marks[dc.mark]?.scrollIntoView({ block: "center" });
  dcKeep(dc.marks[dc.mark], "center");
  dcRenderFind();
}

function dcStep(delta) {
  if (!dc.marks.length) return;
  dc.mark = (dc.mark + delta + dc.marks.length) % dc.marks.length;
  dcShowMark();
}

function dcClearMarks() {
  for (const mark of dc.marks) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent?.normalize();
  }
  dc.marks = [];
  dc.mark = -1;
  dc.terms = null;
  dcRenderFind();
}

function dcRenderFind() {
  const box = $("#doc-find");
  if (!box) return;
  box.hidden = !dc.terms;
  if (!dc.terms) return;
  const count = dc.marks.length;
  box.replaceChildren(
    h("span", {}, !count ? "Not on this page" : dc.mark >= 0 ? `${dc.mark + 1} of ${count}` : plural(count, "match")),
    h("button", { type: "button", title: "Previous match", "aria-label": "Previous match", disabled: !count, onclick: () => dcStep(-1) }, "‹"),
    h("button", { type: "button", title: "Next match", "aria-label": "Next match", disabled: !count, onclick: () => dcStep(1) }, "›"),
    h("button", { type: "button", title: "Clear the marks (Esc)", "aria-label": "Clear the marks", onclick: dcClearMarks }, "×"));
}

function dcEscape() { if (dc.terms) dcClearMarks(); }

// ── Images: a figure opens fitted into the window; a click on it shows it larger ──
function dcZoom(image) {
  const svg = /\.svg$/i.test(image.src);
  const ratio = image.naturalWidth / image.naturalHeight || 1; // an SVG with only a viewBox still has its ratio
  const fit = Math.min(window.innerWidth - 100, (window.innerHeight - 150) * ratio, svg || !image.naturalWidth ? 1800 : image.naturalWidth);
  const large = Math.max(fit * 2, svg ? 0 : image.naturalWidth);
  const big = h("img", { src: image.currentSrc || image.src, alt: image.alt, style: `width:${Math.round(fit)}px` });
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
  const toggle = () => { box.classList.toggle("full"); big.style.width = `${Math.round(box.classList.contains("full") ? large : fit)}px`; };
  const box = h("div", { class: "dc-zoom", role: "dialog", "aria-modal": "true", "aria-label": image.alt || "Image", onclick: (event) => { if (event.target === big) toggle(); else close(); } },
    h("div", { class: "dc-zoom-plate" }, big),
    h("div", { class: "dc-zoom-bar" }, h("span", {}, image.alt || ""), h("a", { href: image.src, target: "_blank", rel: "noopener", onclick: (event) => event.stopPropagation() }, "Open in a new tab")));
  document.body.append(box);
  document.addEventListener("keydown", onKey, true);
}

// ── Events ────────────────────────────────────────────────────────────────────
$("#doc-article").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) {
    const image = event.target.closest(".md-figure img");
    if (image) dcZoom(image);
    return;
  }
  if (link.dataset.anchorLink !== undefined) { // the # beside a heading: its link, copied
    event.preventDefault();
    history.replaceState(history.state, "", link.getAttribute("href"));
    dcScrollTo(link.dataset.anchorLink, true);
    navigator.clipboard?.writeText(location.href);
  } else if (link.dataset.doc !== undefined && dcPlainClick(event)) {
    event.preventDefault();
    dcOpen(link.dataset.doc, link.dataset.anchorTarget || null);
  }
});
$("#doc-outline").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-outline]");
  if (!link || !dcPlainClick(event)) return;
  event.preventDefault();
  history.replaceState(history.state, "", link.getAttribute("href"));
  dcScrollTo(link.dataset.outline, true);
});
for (const type of ["wheel", "touchstart", "pointerdown"]) $("#doc-scroll").addEventListener(type, () => dcKeep(null), { passive: true });
document.addEventListener("keydown", (event) => {
  if (!event.target.closest?.("input, textarea, select") && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) dcKeep(null);
});
$("#doc-scroll").addEventListener("scroll", () => {
  if (state.screen === "doc") dc.scrollTop = $("#doc-scroll").scrollTop;
  if (!dc.spyFrame) dc.spyFrame = requestAnimationFrame(dcSpy);
}, { passive: true });

const dcSearchBox = $("#doc-search");
dcSearchBox.addEventListener("input", () => { clearTimeout(dc.typing); dc.typing = setTimeout(dcRunSearch, 60); });
dcSearchBox.addEventListener("keydown", (event) => {
  if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key) && dc.query !== dcSearchBox.value) { clearTimeout(dc.typing); dcRunSearch(); }
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && dc.results.length) {
    event.preventDefault();
    dc.active = (dc.active + (event.key === "ArrowDown" ? 1 : -1) + dc.results.length) % dc.results.length;
    dcRenderResults();
    $("#doc-tree .dc-result.active")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && dc.results[dc.active]) {
    const result = dc.results[dc.active];
    dcOpen(result.doc.path, result.hits[0]?.entry.anchor ?? null, { terms: dcTerms(dc.query), hit: result.hits[0]?.entry ?? null });
    dcHideSideOnPhones();
  } else if (event.key === "Escape") {
    event.stopPropagation();
    if (dcSearchBox.value) { dcSearchBox.value = ""; dcRunSearch(); } else dcSearchBox.blur();
  }
});
for (const button of document.querySelectorAll("#doc-labels button")) {
  button.addEventListener("click", () => {
    dc.labels = button.dataset.value;
    dcStore("docs-labels", dc.labels);
    dcRenderCount();
    dcRenderTree();
  });
}
$("#doc-refresh").addEventListener("click", dcRefresh);
// "/" or Ctrl+K (⌘K) searches; a doc edited in another window shows its new text on return.
document.addEventListener("keydown", (event) => {
  if (state.screen !== "doc") return;
  const typing = event.target.closest?.("input, textarea, select, [contenteditable]");
  if ((event.key === "/" && !typing) || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    setControlsVisible(true);
    dcSearchBox.focus();
    dcSearchBox.select();
  }
});
window.addEventListener("focus", () => { if (state.screen === "doc" && dc.docs && Date.now() - dc.refreshedAt > 2000) dcRefresh(); });
// A link to a doc on another screen switches screens as the header does, without a history entry.
document.addEventListener("click", (event) => {
  const link = event.target.closest?.('a[href^="#doc/"]');
  if (!link || link.closest("#doc-view") || !dcPlainClick(event)) return;
  event.preventDefault();
  history.replaceState(null, "", link.getAttribute("href"));
  showScreen("doc");
});
window.addEventListener("popstate", (event) => {
  const target = dcFromHash();
  if (!target) return;
  if (state.screen !== "doc") { showScreen("doc"); return; }
  if (dc.docs) dcOpen(target.path || DC_HOME, target.anchor, { push: false, scroll: target.anchor ? null : event.state?.dcScroll ?? null });
});
