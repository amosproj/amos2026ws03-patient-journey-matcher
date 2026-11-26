"use strict";
// ── Database view (read-only) ─────────────────────────────────────────────────
const PRECISION_LENGTH = { year: 4, month: 7, day: 10 };
const DOC_COLUMNS = [["Source", "source"], ["ID", "id"], ["Type"], ["Title", "title"], ["Published", "published"], ["Licence"], ["Full text"], ["Found by"], ["Changed", "changed"], ["Retrieved", "retrieved"], ["Expires", "expires"]];
const DOC_FILTERS = ["db-source", "db-type", "db-origin", "db-topic", "db-licence", "db-fulltext", "db-expiry"];
const db = {
  overview: null, error: null, tab: "documents", table: null, runFilter: null, detailFilter: null, pending: null, selected: null, loading: false,
  docs: { rows: [], total: 0, offset: 0, limit: 50, sort: "changed", order: "desc", ticket: 0 },
  runs: { rows: [], total: 0, offset: 0, limit: 50, ticket: 0 },
  generic: { rows: [], columns: [], total: 0, offset: 0, limit: 50, ticket: 0 },
};

const publishedText = (row) => row.published_at ? row.published_at.slice(0, PRECISION_LENGTH[row.published_precision] || 10) : "";
const runCommand = (run) => `uv run crawler ${run.arguments.map(shellQuote).join(" ")}`;
const runSeconds = (run) => (new Date(run.finished_at) - new Date(run.started_at)) / 1000;
const dbReady = () => Boolean(db.overview && !db.overview.missing.length);

function expiryText(iso) {
  if (!iso) return null;
  const left = new Date(iso) - Date.now();
  const cls = left < 0 ? "expired" : left < 7 * 86400000 ? "expiring" : null;
  return h("span", { class: cls, title: fmtDateTime(iso) }, left < 0 ? `expired ${fmtSpan(left)} ago` : `in ${fmtSpan(left)}`);
}

function dbFilters() {
  return {
    q: $("#db-q").value.trim(), source: $("#db-source").value, type: $("#db-type").value, origin: $("#db-origin").value,
    topic: $("#db-topic").value, licence: $("#db-licence").value, expiry: $("#db-expiry").value, run: db.runFilter,
    fulltext: $("#db-fulltext").value, detail: db.detailFilter,
  };
}

async function dbRefresh() {
  if (db.loading) return;
  db.loading = true;
  try {
    try {
      db.overview = await api("/api/db");
      db.error = null;
    } catch (error) {
      db.overview = null;
      db.error = { message: error.message, hint: error.data?.hint };
    }
    renderDbSide();
    renderDbStats();
    renderDbDown();
    if (db.pending) {
      for (const [id, value] of Object.entries(db.pending)) $(`#${id}`).value = value;
      db.pending = null;
    }
    if (dbReady()) await dbLoadTab();
    $("#db-updated").textContent = `(last ${fmtClock(new Date().toISOString())})`;
  } finally {
    db.loading = false;
  }
}

function dbLoadTab() {
  if (db.tab === "documents") return dbLoadDocs();
  if (db.tab === "runs") return dbLoadRuns();
  if (db.tab === "schema") return dbLoadSchema();
  if (db.tab === "table" && db.table) return dbLoadTable();
}

// Each list keeps a ticket, so a slow answer cannot overwrite a newer one.
async function dbLoadList(list, url, render) {
  const ticket = ++list.ticket;
  try {
    const data = await api(url);
    if (ticket !== list.ticket) return;
    Object.assign(list, data, { error: null });
  } catch (error) {
    if (ticket !== list.ticket) return;
    Object.assign(list, { rows: [], total: 0, error: error.message });
  }
  render();
}

function dbLoadDocs() {
  const docs = db.docs;
  return dbLoadList(docs, `/api/db/documents?${queryString({ ...dbFilters(), sort: docs.sort, order: docs.order, limit: docs.limit, offset: docs.offset })}`, renderDbDocs);
}

function dbLoadRuns() {
  return dbLoadList(db.runs, `/api/db/runs?${queryString({ limit: db.runs.limit, offset: db.runs.offset })}`, renderDbRuns);
}

function dbLoadTable() {
  const table = db.generic;
  return dbLoadList(table, `/api/db/table?${queryString({ name: db.table, limit: table.limit, offset: table.offset })}`, renderDbTable);
}

async function dbLoadSchema() {
  try { renderDbSchema(await api("/api/db/schema")); }
  catch (error) { $("#db-schema").replaceChildren(h("div", { class: "empty" }, error.message)); }
}

function renderDbSide() {
  const box = $("#db-conn");
  const overview = db.overview;
  // replaceChildren would turn a null into the text "null".
  const lines = (...items) => items.filter(Boolean);
  if (db.error) {
    box.className = "db-conn down";
    box.replaceChildren(...lines(h("b", {}, "Not connected"), h("small", {}, db.error.message), db.error.hint && h("span", { class: "hint" }, db.error.hint)));
  } else if (overview) {
    box.className = `db-conn${overview.missing.length ? " warn" : ""}`;
    box.replaceChildren(...lines(
      h("b", {}, overview.database),
      h("small", {}, `${overview.target}, PostgreSQL ${overview.version.split(" ")[0]}, user ${overview.user}`),
      overview.missing.length && h("span", { class: "hint" }, `No ${overview.missing.join(" or ")} table: run make db`),
      h("small", {}, "Only reads; emptying tables asks for the database name."),
    ));
  }
  $("#db-filters").hidden = db.tab !== "documents" || !dbReady();
  renderDbTables();
  renderDbFilterOptions();
}

function renderDbTables() {
  const list = $("#db-tables");
  const tables = db.overview?.tables || [];
  $("#db-empty-all").hidden = !tables.length;
  if (!tables.length) { list.replaceChildren(h("li", { class: "empty" }, db.error ? "–" : "No tables")); return; }
  const active = { documents: "documents", runs: "crawl_runs", table: db.table }[db.tab];
  // A schema per matching approach (keyword) next to the crawler's tables.
  const schemas = new Set(tables.map((table) => table.schema));
  list.replaceChildren(...tables.flatMap((table, index) => [
    schemas.size > 1 && table.schema !== tables[index - 1]?.schema ? h("li", { class: "schema-name" }, `Schema ${table.schema}`) : null,
    h("li", { class: table.name === active ? "active" : null, onclick: () => dbOpenTable(table.name) },
      h("code", {}, table.name),
      h("small", {}, `${plural(table.rows, "row")}, ${fmtBytes(table.bytes)}`),
      h("button", { type: "button", class: "empty-table", title: `Delete every row of ${table.name}, after a confirmation`, onclick: (event) => { event.stopPropagation(); openEmptyDialog([table.name]); } }, "Empty …")),
  ].filter(Boolean)));
}

// ── Emptying tables: a preview of what goes, then the database name typed ──────
let emptying = null;

async function openEmptyDialog(names) {
  let plan;
  try {
    plan = await api(`/api/db/empty-plan?${names.map((name) => `table=${encodeURIComponent(name)}`).join("&")}`);
  } catch (error) {
    showDbNotice(`Cannot empty: ${error.message}`, true);
    return;
  }
  emptying = { names, database: plan.database };
  const total = plan.tables.reduce((sum, table) => sum + table.rows, 0);
  const added = plan.tables.filter((table) => !table.requested).map((table) => table.name);
  $("#empty-title").textContent = names.length > 1 ? "Empty all tables?" : `Empty ${names[0]}?`;
  $("#empty-db").textContent = plan.database;
  $("#empty-name").textContent = plan.database;
  $("#empty-list").replaceChildren(...plan.tables.map((table) => h("li", {},
    h("code", {}, table.name),
    h("small", {}, `${plural(table.rows, "row")}${table.requested ? "" : ", references it"}`))));
  $("#empty-note").textContent = [
    added.length ? `${added.join(", ")} ${added.length === 1 ? "references" : "reference"} the table, so ${added.length === 1 ? "it is" : "they are"} emptied too.` : "",
    plan.tables.some((table) => table.name === "crawl_runs") ? "Store runs start again at #1." : "",
  ].filter(Boolean).join(" ");
  $("#empty-confirm").value = "";
  $("#empty-error").textContent = "";
  $("#empty-submit").textContent = `Delete ${plural(total, "row")}`;
  $("#empty-submit").disabled = true;
  $("#empty-dialog").showModal();
  $("#empty-confirm").focus();
}

function showDbNotice(text, bad = false) {
  const notice = $("#db-notice");
  notice.textContent = text;
  notice.style.color = bad ? "var(--error)" : "";
  notice.hidden = false;
  clearTimeout(showDbNotice.timer);
  showDbNotice.timer = setTimeout(() => { notice.hidden = true; }, 10000);
}

$("#empty-confirm").addEventListener("input", (event) => {
  $("#empty-submit").disabled = event.target.value !== emptying?.database;
});
$("#empty-cancel").addEventListener("click", () => $("#empty-dialog").close());
$("#empty-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const typed = $("#empty-confirm").value;
  if (!emptying || typed !== emptying.database) return;
  $("#empty-submit").disabled = true;
  try {
    const result = await api("/api/db/empty", { method: "POST", body: JSON.stringify({ tables: emptying.names, confirm: typed }) });
    $("#empty-dialog").close();
    Object.assign(db, { runFilter: null, selected: null });
    for (const list of [db.docs, db.runs, db.generic]) list.offset = 0;
    showDbNotice(`Emptied ${result.emptied.map((table) => `${table.name} (${plural(table.rows, "row")})`).join(", ")}.`);
    await dbRefresh();
  } catch (error) {
    $("#empty-error").textContent = error.message;
    $("#empty-submit").disabled = false;
  }
});
$("#db-empty-all").addEventListener("click", () => openEmptyDialog((db.overview?.tables || []).map((table) => table.name)));

function dbOpenTable(name) {
  if (name === "documents") dbSwitchTab("documents");
  else if (name === "crawl_runs") dbSwitchTab("runs");
  else { db.table = name; db.generic.offset = 0; dbSwitchTab("table"); }
}

function fillSelect(select, options) {
  const current = select.value;
  select.replaceChildren(...options.map(([value, label]) => h("option", { value }, label)));
  select.value = options.some(([value]) => value === current) ? current : "";
}

function renderDbFilterOptions() {
  const stats = db.overview?.documents;
  if (!stats) return;
  const unknown = stats.licences.find((facet) => facet.value == null)?.count || 0;
  fillSelect($("#db-source"), [["", `All sources (${stats.total})`], ...stats.sources.map((facet) => [facet.value, `${SOURCE_LABEL[facet.value] || facet.value} (${facet.count})`])]);
  fillSelect($("#db-type"), [["", "All types"], ...stats.types.map((facet) => [facet.value, `${typeLabel(facet.value)} (${facet.count})`])]);
  fillSelect($("#db-topic"), [["", stats.topics.length ? "All topics" : "No topic runs stored yet"], ...stats.topics.map((facet) => [facet.value, `${facet.value} (${facet.count})`])]);
  fillSelect($("#db-licence"), [
    ["", "All licences"], [":known", `Known (${stats.total - unknown})`], [":unknown", `Unknown (${unknown})`],
    ...stats.licences.filter((facet) => facet.value != null).map((facet) => [facet.value, `${facet.value} (${facet.count})`]),
  ]);
  fillSelect($("#db-expiry"), [
    ["", "All"], ["soon", `Expiring within 7 days (${stats.expiring})`], ["expired", `Expired, not deleted yet (${stats.expired})`],
    ["has", "Expires (YouTube)"], ["none", "Never expires"],
  ]);
  $("#db-topic").disabled = !stats.topics.length;
  const fullText = $("#db-fulltext");
  fullText.disabled = !db.overview.keyword_index;
  fullText.parentElement.title = db.overview.keyword_index ? "" : "No keyword index yet: run make index";
}

// A row with a matching filter lists its documents.
function renderDbStats() {
  const box = $("#db-stats");
  const stats = db.overview?.documents;
  if (!stats) { box.replaceChildren(ovSection("Documents", h("b", { class: "ov-total muted" }, "–"))); return; }
  const total = stats.total;
  const list = (filters) => () => dbListDocuments(filters);
  const shown = { title: "Show these documents" };
  const bySource = Object.fromEntries(stats.sources.map((facet) => [facet.value, facet.count]));
  const sources = Object.keys({ ...SOURCE_LABEL, ...bySource }).sort((a, b) => (bySource[b] || 0) - (bySource[a] || 0));
  const runs = db.overview.runs;
  const last = runs?.last;
  box.replaceChildren(
    ovSection("Documents", h("b", { class: "ov-total" }, fmtCount(total)),
      ovList(sources.map((source) => ovShare(SOURCE_LABEL[source] || source, bySource[source], total, { onclick: list({ "db-source": source }) })))),
    ovSection("Share of documents", ovList([
      ovShare("With summary", stats.with_summary, total),
      ovShare("Licence known", stats.with_licence, total, { onclick: list({ "db-licence": ":known" }) }),
      ovShare("Full-text links", stats.with_full_text, total),
      ovShare("Only cited, no search hit", stats.cited_only, total, { onclick: list({ "db-origin": "cited" }) }),
    ])),
    h("section", { class: "ov" }, h("div", { class: "ov-parts" },
      h("div", {}, h("h3", {}, "Expiry"), ovList([
        ovFigure(fmtCount(stats.expiring), "expiring within 7 days", stats.expiring ? { ...shown, onclick: list({ "db-expiry": "soon" }) } : { cls: "zero" }),
        ovFigure(fmtCount(stats.expired), "expired, not deleted yet", stats.expired ? { ...shown, cls: "bad", onclick: list({ "db-expiry": "expired" }) } : { cls: "zero" }),
      ], true)),
      h("div", {}, h("h3", {}, "Store runs"), ovList([
        ovFigure(fmtCount(runs?.total ?? 0), runs?.total === 1 ? "run" : "runs", runs?.total ? { title: "Show the store runs", onclick: () => dbSwitchTab("runs") } : { cls: "zero" }),
        last ? ovFigure(`#${last.id}`, `last run, ${fmtAgo(last.finished_at)}${last.ok ? "" : ", failed"}`, { cls: last.ok ? "" : "bad", title: fmtDateTime(last.finished_at) }) : null,
      ], true)))),
  );
  $("#db-docs-count").textContent = stats.total;
  $("#db-runs-count").textContent = runs?.total ?? 0;
}

function renderDbDown() {
  const box = $("#db-down");
  let title = null, message = null, hint = null;
  if (db.error) [title, message, hint] = ["Database not reachable", db.error.message, db.error.hint];
  else if (db.overview?.missing.length) [title, message, hint] = ["Schema missing", `${db.overview.database} has no ${db.overview.missing.join(" or ")} table.`, "Apply db/init/ from the repository root: make db"];
  box.hidden = !title;
  if (title) box.replaceChildren(h("div", { class: "db-down-box" }, h("h3", {}, title), h("p", {}, message), hint ? h("p", { class: "cmd" }, hint) : null, h("button", { type: "button", onclick: () => dbRefresh() }, "Try again")));
}

function pager(box, list, load) {
  const end = list.offset + list.rows.length;
  box.replaceChildren(
    h("span", { class: "muted" }, list.total ? `${list.offset + 1}–${end} of ${list.total}` : ""),
    h("button", { type: "button", disabled: list.offset === 0, onclick: () => { list.offset = Math.max(0, list.offset - list.limit); load(); } }, "‹ Prev"),
    h("button", { type: "button", disabled: end >= list.total, onclick: () => { list.offset += list.limit; load(); } }, "Next ›"),
    h("select", { title: "Rows per page", onchange: (event) => { list.limit = Number(event.target.value); list.offset = 0; load(); } },
      ...[50, 100, 200, 500].map((size) => h("option", { value: size, selected: size === list.limit }, `${size} / page`))),
  );
}

function dbSort(column) {
  const docs = db.docs;
  if (docs.sort === column) docs.order = docs.order === "desc" ? "asc" : "desc";
  else { docs.sort = column; docs.order = ["title", "id", "source"].includes(column) ? "asc" : "desc"; }
  docs.offset = 0;
  dbLoadDocs();
}

function foundByText(row) {
  return [
    row.queries.length ? `${seedKind(row.source)}: ${row.queries.join(", ")}` : null,
    row.topics.length ? `topic ${row.topics.join(", ")}` : null,
    row.cited_by ? `cited by ${row.cited_by}` : null,
  ].filter(Boolean).join("; ");
}

function renderDbDocs() {
  const docs = db.docs;
  $("#db-docs-head").replaceChildren(...DOC_COLUMNS.map(([label, column]) => column
    ? h("th", { class: `sortable${docs.sort === column ? ` sorted ${docs.order}` : ""}`, title: "Sort by this column", onclick: () => dbSort(column) }, label)
    : h("th", {}, label)));
  const body = $("#db-docs");
  const empty = db.overview?.documents?.total === 0
    ? "No documents stored yet: run the crawler with --store, or tick “Store in the database” on the Runs screen."
    : "No documents match the filters.";
  if (docs.error) body.replaceChildren(messageRow(DOC_COLUMNS.length, docs.error, "small error"));
  else if (!docs.rows.length) body.replaceChildren(messageRow(DOC_COLUMNS.length, empty));
  else body.replaceChildren(...docs.rows.map((row) => h("tr", { class: db.selected?.id === row.id ? "selected" : null, onclick: () => dbOpenDocument(row.id) },
    h("td", {}, sourcePill(row.source)),
    h("td", { class: "id" }, row.id),
    h("td", { class: "small" }, typeLabel(row.content_type)),
    h("td", {}, row.title || h("span", { class: "muted" }, "Untitled")),
    h("td", { class: "when" }, publishedText(row) || "–"),
    h("td", { class: "small" }, row.licence || "–"),
    h("td", { class: "small" }, db.overview?.keyword_index ? fullTextPill(row.full_text_state) : "–"),
    h("td", { class: "small found" }, foundByText(row) || "–"),
    h("td", { class: "when", title: fmtDateTime(row.changed_at) }, fmtAgo(row.changed_at)),
    h("td", { class: "when", title: fmtDateTime(row.retrieved_at) }, fmtAgo(row.retrieved_at)),
    h("td", { class: "small" }, expiryText(row.expires_at) || "–"),
  )));
  $("#db-docs-shown").textContent = docs.error ? "" : `${docs.total} ${docs.total === 1 ? "match" : "matches"}`;
  pager($("#db-docs-pager"), docs, dbLoadDocs);
  const chip = $("#db-run-chip");
  chip.hidden = !db.runFilter;
  if (db.runFilter) chip.replaceChildren(
    h("span", { title: "Documents whose last retrieval falls in the time of this run" }, `Last retrieved during store run #${db.runFilter}`),
    h("button", { type: "button", title: "Remove this filter", onclick: () => { db.runFilter = null; db.docs.offset = 0; dbLoadDocs(); } }, "×"),
  );
  const reason = $("#db-detail-chip");
  reason.hidden = !db.detailFilter;
  if (db.detailFilter) reason.replaceChildren(
    h("span", { title: "Why the keyword index has only the metadata of these documents, or retries their download" }, `Full text: ${db.detailFilter}`),
    h("button", { type: "button", title: "Remove this filter", onclick: () => { db.detailFilter = null; db.docs.offset = 0; dbLoadDocs(); } }, "×"),
  );
}

// The documents with these filter values (IDs of the selects) and this full-text reason.
function dbShowDocuments(filters, detail = null) {
  $("#db-q").value = "";
  for (const id of DOC_FILTERS) $(`#${id}`).value = "";
  Object.assign(db, { runFilter: null, detailFilter: detail, pending: filters, tab: "documents" });
  db.docs.offset = 0;
  showScreen("db");
}

// From the overview above the list: its options are filled already, so filter at once.
function dbListDocuments(filters) {
  $("#db-q").value = "";
  for (const id of DOC_FILTERS) $(`#${id}`).value = filters[id] ?? "";
  Object.assign(db, { runFilter: null, detailFilter: null });
  db.docs.offset = 0;
  if (db.tab === "documents") { dbCloseDetail(); dbLoadDocs(); } else dbSwitchTab("documents");
}

// The Matcher screen shows documents in a panel of its own.
const detailPanel = () => $(state.screen === "match" ? "#mt-detail" : "#db-detail");

function dbShowDetail(parts) {
  const panel = detailPanel();
  panel.replaceChildren(h("button", { class: "close", title: "Close", onclick: dbCloseDetail }, "×"), ...parts);
  panel.classList.add("open");
  panel.scrollTop = 0;
}

function dbCloseDetail() {
  detailPanel().classList.remove("open");
  if (!db.selected) return;
  db.selected = null;
  if (db.tab === "documents") renderDbDocs();
  if (db.tab === "runs") renderDbRuns();
  if (state.screen === "match") mtRenderResults();
}

function copyButton(text) {
  return h("button", { type: "button", class: "copy", title: "Copy to the clipboard", onclick: (event) => { navigator.clipboard?.writeText(text); event.currentTarget.textContent = "copied"; } }, "copy");
}

function dbDocLink(item) {
  // `title` is null for an ID that is not stored (e.g. a citing paper that was deleted).
  const label = item.title ? `${item.id} – ${item.title}` : item.id;
  return item.title == null ? h("span", { class: "muted", title: "Not stored" }, item.id) : h("a", { onclick: () => dbOpenDocument(item.id) }, label);
}

async function dbOpenDocument(id) {
  db.selected = { id };
  if (db.tab === "documents") renderDbDocs();
  if (state.screen === "match") mtRenderResults();
  try {
    const data = await api(`/api/db/document?${queryString({ id })}`);
    if (db.selected?.id === id) renderDbDocument(data);
  } catch (error) {
    dbShowDetail([h("h3", {}, id), h("div", { class: "note" }, error.message)]);
  }
}

// Whether the matcher would find a term in this document.
function termTest(id) {
  const hint = "Whether the matcher finds a term in this document.";
  const result = h("small", {}, hint);
  let timer = 0;
  const found = (value) => value == null ? h("span", { class: "no" }, "–") : h("span", { class: value ? "yes" : "no" }, value ? "✓ found" : "✗ not found");
  const input = h("input", { type: "text", placeholder: "Test a search term, e.g. bone metastases", oninput: () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { result.replaceChildren(hint); return; }
      try {
        const test = await api(`/api/db/term-test?${queryString({ id, q })}`);
        if (input.value.trim() !== q) return;
        if (!test.stems.length) result.replaceChildren("Only stop words: finds nothing anywhere.");
        else result.replaceChildren(`Searched as ${test.stems.join(" + ")}: metadata `, found(test.metadata), ", full text ", found(test.full_text));
      } catch (error) { result.replaceChildren(error.message); }
    }, 250);
  } });
  return h("div", { class: "term-test" }, input, result);
}

function indexParts(doc, index) {
  const parts = [h("div", { class: "label" }, "Keyword index")];
  if (!index) return [...parts, h("div", { class: "note" }, "No keyword index yet: start the indexer on Index › Keyword, or run make index.")];
  const { metadata, full_text: fullText } = index;
  const outdated = (row) => row.current ? null : h("span", { class: "expiring", title: "The document changed since it was indexed; the next indexer run reads it again." }, ", outdated");
  const rows = [
    ["Metadata", metadata ? h("span", {}, metadata.content ? "indexed" : "indexed, empty (not English)", outdated(metadata)) : h("span", { class: "muted" }, "not indexed yet")],
    ["Full text", fullText ? h("span", {}, fullTextPill(fullText.status), fullText.detail ? ` ${fullText.detail}` : "", outdated(fullText)) : h("span", { class: "muted" }, "not read yet")],
  ];
  if (fullText?.url) rows.push(["File", h("a", { href: fullText.url, target: "_blank", rel: "noopener" }, `${fullText.media_type || "file"} ↗`)]);
  if (fullText) rows.push(["Read", fmtDateTime(fullText.fetched_at)]);
  if (fullText?.status === "indexed") rows.push(["Keywords", `${fmtCount(fullText.words)}, ${fmtCount(fullText.distinct_words)} different`]);
  parts.push(h("dl", {}, ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])));
  if (fullText?.top_words.length) parts.push(
    h("div", { class: "label" }, "Most frequent keywords of the full text"),
    barList(fullText.top_words.map(({ word, count }) => ({ name: word, value: count }))));
  parts.push(termTest(doc.id));
  if (metadata) parts.push(h("details", {}, h("summary", {}, "Indexed metadata text"), h("pre", {}, metadata.content)));
  return parts;
}

function renderDbDocument({ document: doc, cited_by: citedBy, cites, index }) {
  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);
  const rows = [
    ["ID", h("span", {}, h("span", { class: "mono" }, doc.id), copyButton(doc.id))],
    ["Link", link(doc.canonical_url, "Open source ↗")],
  ];
  if (doc.version) rows.push(["Version", doc.version]);
  if (doc.publication_types.length) rows.push(["Publication types", doc.publication_types.join(", ")]);
  if (doc.published_at) rows.push(["Published", `${publishedText(doc)} (${doc.published_precision})`]);
  if (doc.source_updated_at) rows.push(["Updated at source", fmtDateTime(doc.source_updated_at)]);
  if (doc.authors.length) rows.push(["Authors", authorList(doc.authors)]);
  if (doc.venue) rows.push([{ podcast: "Show", youtube: "Channel" }[doc.source] || "Venue", doc.venue]);
  if (doc.language) rows.push(["Language", doc.language]);
  if (doc.duration_seconds != null) rows.push(["Duration", fmtDuration(doc.duration_seconds)]);
  rows.push(["Licence", doc.licence || "unknown"]);
  if (doc.doi) rows.push(["DOI", link(`https://doi.org/${doc.doi}`, doc.doi)]);
  const ids = Object.entries(doc.external_ids);
  if (ids.length) rows.push(["External IDs", h("div", { class: "links" }, ...ids.map(([key, value]) => h("span", {}, `${key}: `, externalLink(key, value))))]);
  if (doc.full_text.length) rows.push([`Full text (${doc.full_text.length})`, h("div", { class: "links" }, ...doc.full_text.map((locator) => link(locator.url, [locator.kind, locator.media_type, locator.size ? fmtBytes(locator.size) : null, locator.language].filter(Boolean).join(", "))))]);
  const queries = doc.found_by.filter((entry) => "query" in entry);
  if (queries.length) rows.push(["Found by", h("div", { class: "links" }, ...queries.map((entry) => h("span", {}, `${seedKind(doc.source)} “${entry.query}”${entry.topic ? ` (topic ${entry.topic})` : ""}`)))]);
  if (citedBy.length) rows.push([`Cited by (${citedBy.length})`, h("div", { class: "links" }, ...citedBy.map(dbDocLink))]);
  if (cites.length) rows.push([`Cites (${cites.length} stored)`, h("div", { class: "links" }, ...cites.slice(0, 100).map(dbDocLink), cites.length > 100 ? h("span", { class: "muted" }, `… +${cites.length - 100}`) : null)]);
  rows.push(["First stored", fmtDateTime(doc.created_at)], ["Last changed", fmtDateTime(doc.changed_at)], ["Last retrieved", fmtDateTime(doc.retrieved_at)]);
  if (doc.expires_at) rows.push(["Expires", expiryText(doc.expires_at)]);
  const parts = [
    h("div", {}, sourcePill(doc.source), " ", h("span", { class: "pill plain" }, typeLabel(doc.content_type))),
    h("h3", {}, doc.title || "Untitled"),
  ];
  if (doc.extra?.thumbnail) parts.push(h("img", { class: "thumb", src: doc.extra.thumbnail, alt: "", loading: "lazy" }));
  if (state.screen === "match") parts.push(...mtDocumentParts(doc.id));
  parts.push(h("dl", {}, ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])));
  if (doc.summary) parts.push(h("div", { class: "label" }, "Summary"), h("p", { class: "abstract" }, doc.summary.length > 2000 ? `${doc.summary.slice(0, 2000)} …` : doc.summary));
  parts.push(...indexParts(doc, index));
  const extra = Object.entries(doc.extra || {}).filter(([key]) => key !== "thumbnail");
  if (extra.length) parts.push(h("dl", { class: "extra" }, ...extra.flatMap(([key, value]) => [h("dt", {}, key.replaceAll("_", " ")), h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value))])));
  if (doc.subjects.length) parts.push(h("div", {}, ...doc.subjects.slice(0, 60).map((subject) => h("span", { class: `kw${subject.major ? " major" : ""}`, title: [subject.scheme, subject.id].filter(Boolean).join(" ") }, subject.label))));
  parts.push(h("details", {}, h("summary", {}, "Row (JSON)"), h("pre", {}, JSON.stringify(doc, null, 2))));
  dbShowDetail(parts);
}

function renderDbRuns() {
  const runs = db.runs;
  const body = $("#db-runs");
  const number = (value, cls) => h("td", { class: `num${value ? (cls ? ` ${cls}` : "") : " zero"}` }, value);
  // A crawl over several topics stores one run per topic, all with the same command.
  const topic = (run) => run.topics.length === 1 ? h("td", { class: "small" }, run.topics[0])
    : h("td", { class: "small muted", title: run.topics.join(", ") || null }, run.topics.length ? plural(run.topics.length, "topic") : "–");
  if (runs.error) body.replaceChildren(messageRow(13, runs.error, "small error"));
  else if (!runs.rows.length) body.replaceChildren(messageRow(13, "No store runs yet: run the crawler with --store, or tick “Store in the database” on the Runs screen."));
  else body.replaceChildren(...runs.rows.map((run) => h("tr", { class: db.selected?.run === run.id ? "selected" : null, onclick: () => dbOpenRun(run) },
    h("td", { class: "id" }, `#${run.id}`),
    h("td", { class: "when", title: fmtDateTime(run.finished_at) }, `${fmtDay(run.finished_at)} ${fmtClock(run.finished_at)}`),
    h("td", {}, sourcePill(run.source)),
    topic(run),
    h("td", { class: "cmdcell", title: runCommand(run) }, runCommand(run).replace(/^uv run /, "")),
    h("td", { class: "when" }, fmtSeconds(runSeconds(run))),
    h("td", {}, h("span", { class: `pill ${run.ok ? "ok" : "failed"}`, title: run.run_error || "" }, run.ok ? "ok" : "failed")),
    number(run.inserted), number(run.changed), number(run.unchanged), number(run.cited), number(run.expired), number(run.failures.length, "red"),
  )));
  $("#db-runs-shown").textContent = runs.error ? "" : plural(runs.total, "store run");
  pager($("#db-runs-pager"), runs, dbLoadRuns);
}

function dbOpenRun(run) {
  db.selected = { run: run.id };
  renderDbRuns();
  const pairs = (entries) => entries.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)]);
  const parts = [
    h("div", {}, sourcePill(run.source), " ", h("span", { class: `pill ${run.ok ? "ok" : "failed"}` }, run.ok ? "ok" : "failed")),
    h("h3", {}, `Store run #${run.id}`),
    h("code", { class: "cmd" }, runCommand(run)),
    h("div", { class: "actions" }, h("button", { type: "button", title: "Documents last retrieved during this run", onclick: () => dbFilterRun(run.id) }, "Show its documents")),
    h("dl", {}, ...pairs([
      ["Topics", run.topics.length ? run.topics.join(", ") : "–"],
      ["Started", fmtDateTime(run.started_at)],
      ["Finished", fmtDateTime(run.finished_at)],
      ["Took", fmtSeconds(runSeconds(run))],
      ["Stored", `${run.inserted} new, ${run.changed} changed, ${run.unchanged} unchanged`],
      ["Newly cited", `${plural(run.cited, "stored document")} not fetched again`],
      ["Expired deleted", run.expired],
    ])),
    h("div", { class: "label" }, "Crawl statistics"),
    h("dl", { class: "extra" }, ...pairs(Object.entries(run.stats || {}).map(([key, value]) => [key.replaceAll("_", " "), String(value)]))),
  ];
  if (run.run_error) parts.push(h("div", { class: "note" }, `Run aborted: ${run.run_error}`));
  if (run.failures.length) parts.push(h("div", { class: "label" }, `Failures (${run.failures.length})`), ...run.failures.map((failure) => h("div", { class: "note" },
    `${failure.kind} ${failure.source} (depth ${failure.depth}) ${failure.detail}: ${failure.error}; ${failure.retryable ? `gave up after ${failure.retries} retries` : "not retried"}`)));
  parts.push(h("details", {}, h("summary", {}, "Row (JSON)"), h("pre", {}, JSON.stringify(run, null, 2))));
  dbShowDetail(parts);
}

function dbFilterRun(id) {
  db.runFilter = id;
  db.docs.offset = 0;
  if (db.tab === "documents") { dbCloseDetail(); dbLoadDocs(); } else dbSwitchTab("documents");
}

function renderDbSchema(schema) {
  const group = (items) => items.reduce((map, item) => map.set(item.table, [...(map.get(item.table) || []), item]), new Map());
  // A primary key or unique constraint has an index of the same name; show it once.
  const constraintNames = new Set(schema.constraints.map((item) => item.name));
  const columns = group(schema.columns), constraints = group(schema.constraints);
  const indexes = group(schema.indexes.filter((item) => !constraintNames.has(item.name)));
  const tables = db.overview?.tables || [];
  const extensions = schema.extensions.map((item) => `${item.name} ${item.version}`).join(", ");
  $("#db-schema").replaceChildren(h("div", { class: "muted" }, `Extensions: ${extensions || "none"}`), ...tables.map((table) => h("div", { class: "schema-card" },
    h("h3", {}, h("code", {}, table.name), h("small", {}, `${plural(table.rows, "row")}, ${fmtBytes(table.bytes)}`)),
    h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Column"), h("th", {}, "Type"), h("th", {}, "Null"), h("th", {}, "Default"))),
      h("tbody", {}, ...(columns.get(table.name) || []).map((column) => h("tr", {},
        h("td", { class: "id" }, column.name),
        h("td", { class: "small" }, column.type),
        h("td", { class: "small" }, column.nullable ? "yes" : "–"),
        h("td", { class: "small mono" }, column.default || ""))))),
    h("div", { class: "defs" },
      ...(constraints.get(table.name) || []).map((item) => h("div", {}, h("b", {}, item.name), " ", item.definition)),
      ...(indexes.get(table.name) || []).map((item) => h("div", {}, h("b", {}, item.name), " ", item.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "$1"), `, ${fmtBytes(item.bytes)}`))),
  )));
}

function cellValue(value) {
  if (value == null) return h("td", { class: "small muted" }, "–");
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return h("td", { class: "cell", title: text.length > 60 ? text.slice(0, 2000) : null }, text);
}

function renderDbTable() {
  const table = db.generic;
  $("#db-table-name").textContent = db.table;
  $("#db-table-head").replaceChildren(...table.columns.map((column) => h("th", {}, column)));
  const body = $("#db-table-rows");
  const width = table.columns.length || 1;
  if (table.error) body.replaceChildren(messageRow(width, table.error, "small error"));
  else if (!table.rows.length) body.replaceChildren(messageRow(width, "Empty table"));
  else body.replaceChildren(...table.rows.map((row) => h("tr", { onclick: () => dbShowDetail([h("h3", {}, `Row of ${db.table}`), h("pre", {}, JSON.stringify(row, null, 2))]) },
    ...table.columns.map((column) => cellValue(row[column])))));
  $("#db-table-shown").textContent = table.error ? "" : plural(table.total, "row");
  pager($("#db-table-pager"), table, dbLoadTable);
}

function dbSwitchTab(tab, load = true) {
  db.tab = tab;
  history.replaceState(null, "", tab === "documents" ? "#db" : `#db-${tab}`);
  for (const button of document.querySelectorAll("#db-tabs button")) button.classList.toggle("active", button.dataset.dbtab === tab);
  for (const section of document.querySelectorAll(".dbtab")) section.classList.toggle("active", section.id === `dbtab-${tab}`);
  const tableTab = $("#db-table-tab");
  tableTab.hidden = !db.table;
  tableTab.textContent = db.table ? `Table ${db.table}` : "Table";
  $("#db-filters").hidden = tab !== "documents" || !dbReady();
  dbCloseDetail();
  renderDbTables();
  if (load && dbReady()) dbLoadTab();
}

function openStoreRun(id) {
  db.runFilter = id;
  db.docs.offset = 0;
  db.tab = "documents";
  showScreen("db");
}

for (const button of document.querySelectorAll("#db-tabs button")) button.addEventListener("click", () => dbSwitchTab(button.dataset.dbtab));
let dbTyping = 0;
$("#db-q").addEventListener("input", () => {
  clearTimeout(dbTyping);
  dbTyping = setTimeout(() => { db.docs.offset = 0; dbLoadDocs(); }, 250);
});
for (const id of DOC_FILTERS) $(`#${id}`).addEventListener("change", () => { db.docs.offset = 0; dbLoadDocs(); });
$("#db-reset").addEventListener("click", () => {
  $("#db-q").value = "";
  for (const id of DOC_FILTERS) $(`#${id}`).value = "";
  db.runFilter = null;
  db.detailFilter = null;
  db.docs.offset = 0;
  dbLoadDocs();
});
$("#db-refresh").addEventListener("click", () => dbRefresh());
setInterval(() => { if (state.screen === "db" && $("#db-auto").checked && document.visibilityState === "visible") dbRefresh(); }, 5000);
