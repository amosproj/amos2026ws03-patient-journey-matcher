// Runs: starts crawler runs and shows them live or from the history, with the citation graph.
"use strict";
// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  screen: "runs", meta: null, source: "pubmed", mode: "query", runs: [],
  view: null, run: null, stream: null, liveStart: null,
  counters: null, result: null, options: null, command: "",
  selected: null, tab: "live", renderQueued: false,
};

const graph = {
  nodes: new Map(), edges: [], edgeKeys: new Set(),
  scale: 1, ox: 0, oy: 0, alpha: 1, dirty: true,
  hover: null, drag: null, width: 0, height: 0, dpr: 1,
};

function freshCounters() {
  const kinds = {};
  for (const kind of ["search", "channel", "lookup", "references"]) kinds[kind] = { started: 0, done: 0, errors: 0 };
  return { kinds, fetched: 0, references: 0, retries: 0, waited: 0, seeds: 0, t: 0 };
}

function resetView() {
  state.counters = freshCounters();
  state.result = null; state.options = null; state.command = ""; state.selected = null; state.run = null;
  graph.nodes.clear(); graph.edges = []; graph.edgeKeys.clear();
  graph.scale = 1; graph.ox = 0; graph.oy = 0; graph.alpha = 1; graph.dirty = true;
  $("#log").replaceChildren();
  $("#run-command").textContent = "";
  closeDetail();
}

function showEmptyView() {
  closeStream();
  state.view = null;
  state.liveStart = null;
  resetView();
  $("#log").replaceChildren(h("div", { class: "empty" }, "Start a crawler run or select one from the run history."));
  scheduleRender();
}

// ── Graph data ────────────────────────────────────────────────────────────────
function addNode(id, title, kind, force = false) {
  let node = graph.nodes.get(id);
  if (!node) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 30 + Math.random() * 120;
    node = { id, title, kind, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 };
    graph.nodes.set(id, node);
    graph.alpha = Math.max(graph.alpha, 0.6);
  } else {
    if (title) node.title = title;
    if (force || node.kind !== "seed") node.kind = kind;
  }
  graph.dirty = true;
  return node;
}

function addEdge(from, to) {
  const key = `${from}|${to}`;
  if (graph.edgeKeys.has(key)) return;
  graph.edgeKeys.add(key);
  graph.edges.push([from, to]);
  graph.alpha = Math.max(graph.alpha, 0.4);
  graph.dirty = true;
}

function citingOf(id) { return graph.edges.filter(([, to]) => to === id).map(([from]) => from); }
function citedBy(id) { return graph.edges.filter(([from]) => from === id).map(([, to]) => to).filter((to) => graph.nodes.has(to)); }

// ── Events ────────────────────────────────────────────────────────────────────
function applyEvent(event) {
  const c = state.counters;
  c.t = event.t;
  const kind = c.kinds[event.kind];
  switch (event.type) {
    case "run_started":
      c.seeds = event.seeds; state.options = event.options; state.command = event.command;
      $("#run-command").textContent = event.command;
      break;
    case "request_start": if (kind) kind.started++; break;
    case "request_done":
      if (kind) kind.done++;
      if (event.kind === "references") {
        c.references += event.count;
        for (const [from, targets] of Object.entries(event.edges || {})) for (const to of targets) addEdge(from, to);
      } else {
        c.fetched += event.count;
        for (const doc of event.docs || []) addNode(doc.id, doc.title, event.kind === "lookup" ? "cited" : "seed");
      }
      break;
    case "request_error": if (kind) kind.errors++; break;
    case "retry": c.retries++; break;
    case "backoff": c.waited += event.seconds; break;
  }
  appendLog(event);
  scheduleRender();
}

function applyResult(result) {
  state.result = result;
  const kept = new Set();
  for (const doc of result.documents) {
    kept.add(doc.id);
    const isSeed = doc.found_by.some((entry) => "query" in entry);
    addNode(doc.id, doc.title, isSeed ? "seed" : "cited", true);
    for (const entry of doc.found_by) if (entry.cited_by) addEdge(entry.cited_by, doc.id);
  }
  for (const node of graph.nodes.values()) if (!kept.has(node.id)) node.kind = "dropped";
  scheduleRender();
}

function logText(event) {
  const where = [event.kind, event.source, event.detail].filter(Boolean).join(" ");
  switch (event.type) {
    case "run_started": return ["run", `Start: ${event.command} (${plural(event.seeds, "seed request")})`];
    case "request_start": return ["start", `→ ${where}`];
    case "request_done":
      if (event.kind === "references") return ["ok", `✓ ${where} → ${plural(event.count, "cited ID")} (${event.seconds} s)`];
      return ["ok", `✓ ${where} → ${event.count}${event.requested ? ` of ${event.requested}` : ""} document${event.count === 1 ? "" : "s"} (${event.seconds} s)`];
    case "request_error": return ["err", `✗ ${where}: ${event.error} (${event.seconds} s)`];
    case "retry": return ["warn", `↻ ${event.message}`];
    case "backoff": return ["warn", `   waiting ${event.seconds} s`];
    case "warning": return ["warn", `⚠ ${event.message}`];
    case "cancel_requested": return ["warn", "Stop requested …"];
    case "run_finished": return ["run", `Done: ${plural(event.documents, "document")}, ${plural(event.failures, "failed request")}${event.run_error ? `, aborted: ${event.run_error}` : ""}`];
    case "run_cancelled": return ["err", `Run stopped${event.documents != null ? `: ${plural(event.documents, "document")} so far` : ""}`];
    case "run_failed": return ["err", `Run failed: ${event.error}`];
    case "store_started": return ["start", "Storing in the database …"];
    case "refreshed": return ["ok", `Refreshed ${event.refreshed} of ${plural(event.due, "stored video")} that expire soon`];
    case "stored": return ["run", `Stored as store run #${event.run_id}: ${event.inserted} new, ${event.changed} changed, ${event.unchanged} unchanged; ${plural(event.cited, "stored document")} newly cited; ${event.expired} expired deleted`];
    case "store_failed": return ["err", `Storing failed: ${event.error}`];
    default: return ["start", JSON.stringify(event)];
  }
}

function appendLog(event) {
  const log = $("#log");
  if (log.firstElementChild?.classList.contains("empty")) log.replaceChildren();
  const [cls, text] = logText(event);
  const link = event.type === "stored" ? h("a", { onclick: () => openStoreRun(event.run_id) }, " → show in the database") : null;
  const line = h("div", { class: cls, "data-type": event.type }, h("span", { class: "t" }, `${event.t.toFixed(1)} s`), h("span", {}, text, link));
  if (event.type === "request_start" && !$("#show-starts").checked) line.style.display = "none";
  log.append(line);
  while (log.childElementCount > LOG_LIMIT) log.firstElementChild.remove();
  if ($("#follow").checked && state.tab === "live") log.scrollTop = log.scrollHeight;
}

// ── Streaming ─────────────────────────────────────────────────────────────────
function closeStream() {
  if (state.stream) { state.stream.close(); state.stream = null; }
}

function openStream(id, from = 0) {
  closeStream();
  const stream = new EventSource(`/api/events?run=${encodeURIComponent(id)}&from=${from}`);
  state.stream = stream;
  stream.onmessage = (message) => { if (state.view === id) applyEvent(JSON.parse(message.data)); };
  stream.addEventListener("end", () => { stream.close(); finishView(id); });
  stream.onerror = () => { if (stream.readyState === EventSource.CLOSED) finishView(id); };
}

async function finishView(id) {
  closeStream();
  try {
    const data = await api(`/api/runs/${id}`);
    if (state.view !== id) return;
    state.run = data;
    if (data.result && !state.result) applyResult(data.result);
  } catch (error) { /* the run may have been deleted */ }
  state.liveStart = null;
  setRunning(false);
  await refreshRuns();
  scheduleRender();
}

async function viewRun(id, live) {
  closeStream();
  resetView();
  state.view = id;
  highlightRun();
  if (live) {
    state.liveStart = performance.now();
    openStream(id, 0);
    return;
  }
  const data = await busyArea($("#runs-view .content"), api(`/api/runs/${id}`));
  if (state.view !== id) return;
  state.run = data;
  for (const event of data.events) applyEvent(event);
  if (data.result) applyResult(data.result);
  if (data.status === "running") {
    state.liveStart = performance.now() - (data.events.at(-1)?.t || 0) * 1000;
    setRunning(true);
    openStream(id, data.events.length);
  } else {
    state.liveStart = null;
  }
  const log = $("#log");
  log.scrollTop = log.scrollHeight;
  scheduleRender();
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderStats();
    renderBadges();
    if (state.tab === "docs") renderDocs();
    if (state.tab === "failures") renderFailures();
  });
}

function renderStats() {
  const box = $("#stats");
  const s = state.result?.stats;
  // A finished run splits into wholes; the live counters have none yet (requests keep coming).
  box.classList.toggle("overview", Boolean(s));
  if (s) {
    const n = (key) => s[key] ?? 0; // older run files lack the newer counters
    const documents = n("documents"), references = n("references_found");
    // Every request ends in one of these three.
    const requests = n("finished_requests") + n("failed_requests") + n("unprocessed_requests");
    const searched = (state.result.documents || []).filter((doc) => doc.found_by?.some((entry) => "query" in entry)).length;
    const showDocs = (origin) => () => { $("#origin-filter").value = origin; switchTab("docs"); };
    // Every cited ID found is looked up, or skipped for one of four reasons.
    const reference = (label, key, options) => ovShare(label, n(key), references, { unit: "references", ...options });
    const request = (label, key, options) => ovShare(label, n(key), requests, { unit: "requests", ...options });
    box.replaceChildren(...[
      ovSection("Documents", h("b", { class: "ov-total" }, fmtCount(documents)), ovList([
        ovShare("Search results", searched, documents, { color: "--seed", onclick: showDocs("seed") }),
        ovShare("Cited", documents - searched, documents, { color: "--cited", onclick: showDocs("cited") }),
      ])),
      references ? ovSection(["References found", h("b", {}, fmtCount(references))], ovList([
        reference("Queued for lookup", "lookups_queued"),
        reference("not returned by the source", "lookups_missing", { sub: true }),
        reference("dropped (off-topic)", "skipped_off_topic", { sub: true, color: "--dropped", onclick: showDocs("dropped") }),
        reference("Duplicates", "skipped_duplicate", { tip: "Found in this run already" }),
        reference("Already stored", "skipped_known", { tip: "In the database already (Store loads their IDs), so not looked up again" }),
        n("skipped_rarely_cited") ? reference("Cited too rarely", "skipped_rarely_cited", { tip: "Fewer of the collected papers cite them than Min citations asks for, so they are not looked up" }) : null,
        n("skipped_invalid") ? reference("Invalid", "skipped_invalid", { tip: "A paper citing itself, or an ID the source cannot have" }) : null,
      ])) : null,
      ovSection(["Requests", h("b", {}, fmtCount(requests))], ovList([
        request("OK", "finished_requests", { color: "--good" }),
        request("Failed", "failed_requests", { color: "--critical", onclick: () => switchTab("failures") }),
        request("Not processed", "unprocessed_requests", { color: "--pending", tip: "The run stopped before they ran: Stop, Max requests or an error" }),
      ])),
      ovSection("Run", ovList([
        ovFigure(fmtCount(n("seed_requests")), n("seed_requests") === 1 ? "seed request" : "seed requests"),
        s.max_results_reached == null ? null : ovFigure(fmtCount(s.max_results_reached), "reached max results", {
          cls: s.max_results_reached ? "warn" : "zero",
          title: "Seed requests with since that returned max results: older documents of the period may be missing",
        }),
        ovFigure(fmtSeconds(state.run?.duration), "duration"),
      ], true)),
    ].filter(Boolean));
    return;
  }
  const c = state.counters;
  if (!c || !state.view) { box.replaceChildren(card("Documents", "–", "muted"), card("References", "–", "muted"), card("Requests", "–", "muted")); return; }
  const kinds = Object.values(c.kinds);
  const started = kinds.reduce((sum, k) => sum + k.started, 0);
  const done = kinds.reduce((sum, k) => sum + k.done, 0);
  const errors = kinds.reduce((sum, k) => sum + k.errors, 0);
  const elapsed = state.liveStart ? (performance.now() - state.liveStart) / 1000 : c.t;
  box.replaceChildren(
    card("Documents fetched", c.fetched),
    card("Seed requests", c.seeds),
    card("References found", c.references),
    card("Source calls ok", `${done} / ${started}`),
    card("Failed attempts", errors, errors ? "bad" : "muted"),
    card("Retries", c.retries, c.retries ? "" : "muted"),
    card("Backoff wait", fmtSeconds(c.waited), c.waited ? "" : "muted"),
    card("Elapsed", fmtSeconds(elapsed)),
  );
}

function renderBadges() {
  $("#docs-count").textContent = state.result ? state.result.documents.length : graph.nodes.size;
  const failures = state.result ? state.result.failures.length : (state.counters ? Object.values(state.counters.kinds).reduce((sum, k) => sum + k.errors, 0) : 0);
  const badge = $("#fail-count");
  badge.textContent = failures;
  badge.classList.toggle("bad", failures > 0);
  const download = $("#download");
  if (state.result && state.view) { download.style.display = ""; download.href = `/api/runs/${state.view}/jsonl`; }
  else download.style.display = "none";
}

function foundBySummary(doc) {
  const queries = doc.found_by.filter((entry) => "query" in entry).map((entry) => entry.topic ? `${entry.query} [${entry.topic}]` : entry.query);
  const cited = doc.found_by.filter((entry) => entry.cited_by).length;
  return [queries.length ? `${seedKind(doc.source)}: ${queries.join(", ")}` : null, cited ? `cited by ${cited}` : null].filter(Boolean).join("; ");
}

function docRows() {
  if (state.result) {
    const rows = state.result.documents.map((doc) => ({
      id: doc.id, title: doc.title, published: doc.published_on || "", type: typeLabel(doc.content_type), licence: doc.licence || "",
      origin: doc.found_by.some((entry) => "query" in entry) ? "seed" : "cited",
      foundBy: foundBySummary(doc),
    }));
    for (const node of graph.nodes.values()) {
      if (node.kind === "dropped") rows.push({ id: node.id, title: node.title, published: "", origin: "dropped", foundBy: `cited by ${citingOf(node.id).length}` });
    }
    return rows;
  }
  return [...graph.nodes.values()].map((node) => ({
    id: node.id, title: node.title, published: "", origin: node.kind,
    foundBy: node.kind === "cited" ? `cited by ${citingOf(node.id).length}` : "",
  }));
}

const ROW_LIMIT = 2000;
function renderDocs() {
  const needle = $("#filter").value.trim().toLowerCase();
  const origin = $("#origin-filter").value;
  const rows = docRows().filter((row) => (!origin || row.origin === origin) && (!needle || row.id.toLowerCase().includes(needle) || (row.title || "").toLowerCase().includes(needle)));
  const body = $("#docs");
  if (!rows.length) {
    body.replaceChildren(h("tr", {}, h("td", { colspan: 7, class: "small" }, state.view ? "No documents" : "No run selected yet")));
  } else {
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice(0, ROW_LIMIT)) {
      fragment.append(h("tr", { class: row.id === state.selected ? "selected" : null, onclick: () => selectDoc(row.id) },
        h("td", {}, h("span", { class: `pill ${row.origin}` }, ORIGIN_LABEL[row.origin])),
        h("td", { class: "id" }, row.id),
        h("td", { class: "small" }, row.type || "–"),
        h("td", {}, row.title || "–"),
        h("td", { class: "small" }, row.published),
        h("td", { class: "small" }, row.licence || "–"),
        h("td", { class: "small found" }, row.foundBy),
      ));
    }
    body.replaceChildren(fragment);
  }
  $("#docs-shown").textContent = rows.length > ROW_LIMIT ? `${ROW_LIMIT} of ${rows.length} shown` : `${rows.length} shown`;
}

function renderFailures() {
  const body = $("#failures");
  if (state.result) {
    const failures = state.result.failures;
    if (!failures.length && !state.result.run_error) { body.replaceChildren(h("tr", {}, h("td", { colspan: 6, class: "small" }, "No failures"))); return; }
    const rows = failures.map((failure) => h("tr", {},
      h("td", {}, failure.kind), h("td", {}, failure.source), h("td", {}, failure.depth),
      h("td", { class: "small" }, failure.detail), h("td", {}, failure.error),
      h("td", { class: "small" }, failure.retryable ? `${failure.retries} (gave up)` : "none (not retried)"),
    ));
    if (state.result.run_error) rows.push(h("tr", {}, h("td", { colspan: 4 }, "Run aborted"), h("td", { colspan: 2 }, state.result.run_error)));
    body.replaceChildren(...rows);
    return;
  }
  const errors = [...$("#log").querySelectorAll('[data-type="request_error"]')].map((line) => line.lastChild.textContent);
  body.replaceChildren(errors.length
    ? h("tr", {}, h("td", { colspan: 6, class: "small" }, "The run is still in progress. Failed attempts so far:", h("br"), ...errors.flatMap((text) => [text, h("br")])))
    : h("tr", {}, h("td", { colspan: 6, class: "small" }, state.view ? "No failures" : "No run selected yet")));
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function closeDetail() { $("#detail").classList.remove("open"); state.selected = null; graph.dirty = true; }

function docLink(id) {
  const node = graph.nodes.get(id);
  const label = node && node.title ? `${id} – ${node.title}` : id;
  return graph.nodes.has(id) ? h("a", { onclick: () => selectDoc(id) }, label) : h("span", {}, label);
}

function selectDoc(id) {
  if (!id) return;
  state.selected = id;
  graph.dirty = true;
  const doc = state.result?.documents.find((entry) => entry.id === id);
  const node = graph.nodes.get(id);
  const kind = doc ? (doc.found_by.some((entry) => "query" in entry) ? "seed" : "cited") : node?.kind || "cited";
  const url = doc?.url || urlFor(id);
  const parts = [
    h("button", { class: "close", title: "Close", onclick: closeDetail }, "×"),
    h("span", { class: `pill ${kind}` }, ORIGIN_LABEL[kind]),
    h("h3", {}, doc?.title || node?.title || id),
  ];
  const rows = [["ID", id]];
  if (url) rows.push(["Link", h("a", { href: url, target: "_blank", rel: "noopener" }, "Open source ↗")]);
  if (doc) {
    if (doc.content_type) rows.push(["Type", typeLabel(doc.content_type)]);
    if (doc.publication_types?.length) rows.push(["Publication types", doc.publication_types.join(", ")]);
    if (doc.published_at) rows.push(["Published", `${doc.published_on} (${doc.published_precision})`]);
    if (doc.source_updated_at) rows.push(["Updated at source", doc.source_updated_at.slice(0, 10)]);
    if (doc.authors?.length) rows.push(["Authors", authorList(doc.authors)]);
    if (doc.journal) rows.push([doc.source === "podcast" ? "Show" : "Journal", doc.journal]);
    if (doc.language) rows.push(["Language", doc.language]);
    if (doc.duration_seconds != null) rows.push(["Duration", fmtDuration(doc.duration_seconds)]);
    rows.push(["Licence", doc.licence || "unknown"]);
    if (doc.version) rows.push(["Version", doc.version]);
    if (doc.doi) rows.push(["DOI", h("a", { href: `https://doi.org/${doc.doi}`, target: "_blank", rel: "noopener" }, doc.doi)]);
    if (doc.channel_id) rows.push(["Channel", doc.channel_id]);
    const ids = Object.entries(doc.external_ids || {});
    if (ids.length) rows.push(["External IDs", h("div", { class: "links" }, ...ids.map(([key, value]) => h("span", {}, `${key}: `, externalLink(key, value))))]);
    if (doc.full_text?.length) rows.push([`Full text (${doc.full_text.length})`, h("div", { class: "links" }, ...doc.full_text.map((locator) => h("a", { href: locator.url, target: "_blank", rel: "noopener" }, [locator.kind, locator.media_type, locator.size ? fmtBytes(locator.size) : null, locator.language].filter(Boolean).join(", "))))]);
    const queries = doc.found_by.filter((entry) => "query" in entry);
    if (queries.length) rows.push(["Found by", h("div", { class: "links" }, ...queries.map((entry) => h("span", {}, `${seedKind(doc.source)} “${entry.query}”${entry.topic ? ` (topic ${entry.topic})` : ""}`)))]);
  }
  const citing = doc ? doc.found_by.filter((entry) => entry.cited_by).map((entry) => entry.cited_by) : citingOf(id);
  if (citing.length) rows.push([`Cited by (${citing.length})`, h("div", { class: "links" }, ...citing.map(docLink))]);
  const cites = citedBy(id);
  if (cites.length) rows.push([`Cites (${cites.length} fetched)`, h("div", { class: "links" }, ...cites.slice(0, 50).map(docLink), cites.length > 50 ? h("span", {}, `… +${cites.length - 50}`) : null)]);
  parts.push(h("dl", {}, ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)])));
  if (kind === "dropped") {
    const terms = state.options?.topic_terms || [];
    parts.push(h("div", { class: "note" }, "Fetched as a cited paper but dropped: it does not match the topic filter.", terms.length ? h("br") : null, terms.length ? `Terms: ${terms.join(", ")}` : null));
  }
  if (doc) {
    const text = doc.abstract || doc.description;
    if (text) parts.push(h("dt", { style: "color:var(--muted);font-size:12px;margin-top:6px" }, doc.abstract ? "Abstract" : "Description"), h("p", { class: "abstract" }, text.length > 1500 ? `${text.slice(0, 1500)} …` : text));
    if (doc.extra?.thumbnail) parts.splice(3, 0, h("img", { class: "thumb", src: doc.extra.thumbnail, alt: "", loading: "lazy" }));
    const extra = Object.entries(doc.extra || {}).filter(([key]) => key !== "thumbnail");
    if (extra.length) parts.push(h("dl", { class: "extra" }, ...extra.flatMap(([key, value]) => [h("dt", {}, key.replaceAll("_", " ")), h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value))])));
    if (doc.subjects?.length) parts.push(h("div", {}, ...doc.subjects.slice(0, 40).map((subject) => h("span", { class: `kw${subject.major ? " major" : ""}`, title: [subject.scheme, subject.id].filter(Boolean).join(" ") }, subject.label))));
    parts.push(h("details", {}, h("summary", {}, "Raw data (JSON)"), h("pre", {}, JSON.stringify(doc, null, 2))));
  } else if (!state.result) {
    parts.push(h("div", { class: "note" }, "All fields appear when the run is done."));
  }
  const panel = $("#detail");
  panel.replaceChildren(...parts);
  panel.classList.add("open");
  panel.scrollTop = 0;
  if (state.tab === "docs") renderDocs();
}

// ── Form ──────────────────────────────────────────────────────────────────────
function setupSeg(id, onChange) {
  for (const button of document.querySelectorAll(`#${id} button`)) {
    button.addEventListener("click", () => {
      for (const other of document.querySelectorAll(`#${id} button`)) other.classList.toggle("active", other === button);
      onChange(button.dataset.value);
    });
  }
}

function formBody() {
  const number = (id) => { const value = $(`#${id}`).value; return value === "" ? null : Number(value); };
  return {
    source: state.source, mode: state.mode,
    query: $("#query").value,
    topics: [...document.querySelectorAll("#topics input:checked")].map((input) => input.value),
    max_results: number("max_results"),
    max_depth: number("max_depth"),
    min_citations: number("min_citations"),
    max_requests: number("max_requests"),
    since: $("#since").value || null,
    query_mode: $("#query_mode").value,
    store: $("#store").checked && !$("#store").disabled,
  };
}

function updateCommand() {
  const body = formBody();
  const argv = [body.source];
  const add = (flag, value) => { if (value != null && value !== "") argv.push(flag, String(value)); };
  add("--max-results", body.max_results);
  if (["pubmed", "arxiv"].includes(body.source)) add("--max-depth", body.max_depth);
  if (["pubmed", "arxiv"].includes(body.source) && body.min_citations !== 1) add("--min-citations", body.min_citations);
  add("--since", body.since);
  if (["arxiv", "zenodo"].includes(body.source)) add("--query-mode", body.query_mode);
  add("--max-requests", body.max_requests);
  if (body.store) argv.push("--store");
  if (body.mode === "topic") for (const topic of body.topics) argv.push("--topic", topic);
  else if (body.query.trim()) argv.push(...(body.query.trim().startsWith("-") ? ["--"] : []), body.query.trim());
  $("#cmd").textContent = `uv run crawler ${argv.map(shellQuote).join(" ")}`;
}

function updateForm() {
  const youtube = state.source === "youtube";
  for (const element of document.querySelectorAll("[data-sources]")) {
    element.style.display = element.dataset.sources.split(" ").includes(state.source) ? "" : "none";
  }
  $("#query-field").style.display = state.mode === "query" ? "" : "none";
  $("#topic-field").style.display = state.mode === "topic" ? "" : "none";
  const query = $("#query");
  const defaults = { youtube: "UCRVdFy0DLWhIApG8LWDzV1w", podcast: "jco" };
  const placeholders = { youtube: "Channel: @handle, channel ID or URL", podcast: "Feed key, e.g. jco" };
  query.placeholder = placeholders[state.source] || "Search query";
  if (["prostate cancer", ...Object.values(defaults)].includes(query.value)) query.value = defaults[state.source] || "prostate cancer";
  $("#feed-keys").replaceChildren(...(state.source === "podcast" ? state.meta?.feeds || [] : []).map((feed) => h("option", { value: feed.key }, `${feed.name} (${feed.audience})`)));
  renderTopics();
  updateCommand();
}

function renderTopics() {
  const box = $("#topics");
  const checked = new Set([...box.querySelectorAll("input:checked")].map((input) => input.value));
  const topics = state.meta?.topics || [];
  const units = { youtube: ["channels", "channel", "channels"], podcast: ["podcasts", "feed", "feeds"] };
  const [field, one, many] = units[state.source] || ["queries", "query", "queries"];
  box.replaceChildren(...topics.map((topic) => {
    const count = topic[field] || 0;
    const usable = !topic.error && count > 0;
    const unit = count === 1 ? one : many;
    return h("label", { class: usable ? null : "disabled", title: topic.error || (topic.terms?.length ? `Filter terms: ${topic.terms.join(", ")}` : "") },
      h("input", { type: "checkbox", value: topic.id, disabled: !usable, checked: usable && checked.has(topic.id), onchange: updateCommand }),
      h("span", {}, topic.label),
      h("small", {}, topic.error ? "error" : `${count} ${unit}`));
  }));
}

function setRunning(running) {
  $("#start").disabled = running;
  $("#stop").disabled = !running;
}

async function deleteRun(id) {
  await api(`/api/runs/${id}`, { method: "DELETE" });
  if (state.view === id) showEmptyView();
  await refreshRuns();
}

async function refreshRuns() {
  state.runs = await api("/api/runs");
  const list = $("#runs");
  $("#clear-runs").style.visibility = state.runs.some((run) => run.status !== "running") ? "visible" : "hidden";
  if (!state.runs.length) { list.replaceChildren(h("li", { class: "empty" }, "No runs yet")); return; }
  list.replaceChildren(...state.runs.map((run) => {
    const running = run.status === "running";
    const count = running ? "running" : run.documents != null ? `${plural(run.documents, "doc")}${run.stored ? ", stored" : ""}` : run.status;
    const remove = running ? h("span") : h("button", {
      class: "del", type: "button", title: "Delete this run",
      onclick: (event) => { event.stopPropagation(); armOrRun(event.currentTarget, "Delete?", () => deleteRun(run.id)); },
    }, "✕");
    return h("li", { "data-id": run.id, onclick: () => viewRun(run.id, false), title: run.command },
      h("span", { class: `status-dot ${run.status}` }),
      h("span", { class: "when" }, `${fmtDay(run.started_at)} ${fmtClock(run.started_at)}`),
      h("span", { class: "count" }, count),
      remove,
      h("span", { class: "what" }, run.command.replace(/^uv run crawler /, "")),
    );
  }));
  highlightRun();
}

function highlightRun() {
  for (const item of document.querySelectorAll("#runs li")) item.classList.toggle("active", item.dataset.id === state.view);
}

function switchTab(tab) {
  state.tab = tab;
  history.replaceState(null, "", tab === "live" ? location.pathname : `#${tab}`);
  for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("active", button.dataset.tab === tab);
  for (const section of document.querySelectorAll(".tab")) section.classList.toggle("active", section.id === `tab-${tab}`);
  if (tab === "graph") resizeCanvas();
  if (tab === "live") { const log = $("#log"); log.scrollTop = log.scrollHeight; }
  scheduleRender();
}

$("#form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  try {
    const started = await api("/api/runs", { method: "POST", body: JSON.stringify(formBody()) });
    setRunning(true);
    await viewRun(started.id, true);
    switchTab("live");
    refreshRuns();
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
});
$("#stop").addEventListener("click", async () => {
  try { await api("/api/cancel", { method: "POST" }); } catch (error) { $("#form-error").textContent = error.message; }
});
$("#clear-runs").addEventListener("click", (event) => armOrRun(event.currentTarget, "Delete all runs?", async () => {
  const viewingRunning = state.runs.some((run) => run.id === state.view && run.status === "running");
  await api("/api/runs", { method: "DELETE" });
  if (state.view && !viewingRunning) showEmptyView();
  await refreshRuns();
}));
for (const id of ["query", "max_results", "max_depth", "min_citations", "max_requests", "since", "query_mode", "store"]) $(`#${id}`).addEventListener("input", updateCommand);
for (const button of document.querySelectorAll("#tabs button")) button.addEventListener("click", () => switchTab(button.dataset.tab));
$("#filter").addEventListener("input", () => renderDocs());
$("#origin-filter").addEventListener("change", () => renderDocs());
$("#show-starts").addEventListener("change", (event) => {
  for (const line of document.querySelectorAll('#log [data-type="request_start"]')) line.style.display = event.target.checked ? "" : "none";
});
window.addEventListener("resize", () => { if (state.tab === "graph") resizeCanvas(); });
setInterval(() => { if (state.liveStart && !state.result) renderStats(); }, 500);

setupSeg("source", (value) => { state.source = value; updateForm(); });
setupSeg("mode", (value) => { state.mode = value; updateForm(); });
