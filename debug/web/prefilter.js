"use strict";
// ── Pre-filter: the labels of the document pre-filter study (#92), many documents at a time ──
// The labels live in research/prefilter/labels.json. The label the LLM proposed counts unless a
// person changes it here. A card's document fields come from the database, read only; a
// document that is no longer stored can still be labeled.
// `offset` is where the page on screen starts; `documents` maps the page's ids to their fields
// (null: not stored), and is null itself while loading or when the database failed.
const PF_SIZES = [12, 24, 48, 96];
const pfStoredSize = () => { try { return Number(localStorage.getItem("pf-size")); } catch { return 0; } };
const pf = { tab: "label", data: null, offset: 0, size: PF_SIZES.includes(pfStoredSize()) ? pfStoredSize() : 24, documents: null, failed: null, saving: new Set(), load: 0 };
const PF_SET_LABEL = { train: "Training", random: "Random test", "drops-rules": "Rule drops", "drops-model": "Model drops" };
const pfSetLabel = (name) => PF_SET_LABEL[name] || (name.startsWith("drops-rule:") ? `Drops of ${name.slice(11)}` : name.startsWith("drops-model:") ? `Model drops ${name.slice(12)}`.trim() : name);
const PF_STATUS = { unchecked: ["LLM label", "none"], accepted: ["confirmed", "ok"], changed: ["changed", "plain"] };
const PF_CHOICES = [["keep", null, "Keep"], ["unhelpful", 1, "Unhelpful 1"], ["unhelpful", 2, "Unhelpful 2"]];

const PF_HASH = { label: "#prefilter", results: "#prefilter-results", drops: "#prefilter-drops" };

function pfShow() {
  history.replaceState(null, "", PF_HASH[pf.tab]);
  pfSwitchTab(pf.tab);
  pfRefresh();
}

function pfSwitchTab(tab) {
  pf.tab = tab;
  for (const name of Object.keys(PF_HASH)) $(`#pftab-${name}`).hidden = tab !== name;
  // The side panel filters what the tab on screen shows: labels, or the drop list.
  $("#pf-label-filters").hidden = tab === "drops";
  $("#pf-drop-filters").hidden = tab !== "drops";
  for (const button of document.querySelectorAll("#pf-tabs button")) button.classList.toggle("active", button.dataset.pftab === tab);
  if (state.screen === "prefilter") history.replaceState(null, "", PF_HASH[tab]);
  if (tab === "results" && typeof pfResults === "function") pfResults();
  if (tab === "drops" && typeof pdRefresh === "function") pdRefresh();
}

async function pfRefresh() {
  pdLoadCounts(); // for the pipeline strip, also while another tab is on screen
  const filter = { set: $("#pf-set").value, status: $("#pf-status").value, label: $("#pf-label-filter").value };
  try {
    pf.data = await api(`/api/prefilter/labels?${queryString({ ...filter, limit: pf.size, offset: pf.offset })}`);
    $("#pf-error").textContent = "";
  } catch (error) {
    pf.data = null;
    $("#pf-error").textContent = error.message;
  }
  // Past the end after a filter shrank: back to the last page.
  if (pf.data?.items && !pf.data.items.length && pf.offset > 0) {
    pf.offset = Math.max(0, Math.floor((pf.data.total - 1) / pf.size) * pf.size);
    return pfRefresh();
  }
  pfRenderControls();
  await pfLoadDocuments();
}

// The study in one row: each step with how far it is. "done", "todo", "warn" or "optional".
function pfRenderPipeline() {
  const p = pf.data?.pipeline;
  if (!p) { $("#pf-stats").replaceChildren(); return; }
  const progress = pf.data.progress || {};
  const model = p.model;
  const rules = p.rules;
  const steps = [
    ["Sample", Object.entries(progress).filter(([name]) => !name.startsWith("drops-")).map(([name, n]) => `${fmtCount(n.total)} ${pfSetLabel(name).toLowerCase()}`).join(" · ") || "none yet",
      p.documents ? "done" : "todo", "scripts/prefilter.py sample: random documents to label"],
    ["LLM labels", `${fmtCount(p.proposed)} of ${fmtCount(p.documents)} · ${Object.entries(p.by_model).map(([name, n]) => `${name} ${fmtCount(n)}`).join(", ") || "none"}`,
      p.documents && p.proposed === p.documents ? "done" : "todo", "propose / import-proposals: a local LLM labels each document keep or unhelpful (group 1 or 2)"],
    ["People correct", `${fmtCount(p.by_person)} seen · optional`, "optional", "Here, on the cards: a person's label replaces the LLM's"],
    ["Rules", rules ? `drop ${fmtCount(rules.dropped)} · ${pfPercent(rules.share)}` : "not measured", rules ? "done" : "todo", "Metadata rules (errata, no summary …) drop documents before the classifier"],
    ["Classifier", model ? `trained on ${fmtCount(model.trained_on)} · ${model.threshold == null ? "no safe threshold" : `threshold ${model.threshold.toFixed(3)}`}` : "not trained",
      !model ? "todo" : model.threshold == null ? "warn" : "done", "train: logistic regression on the stored embeddings; the threshold drops ≥ 100 training documents with ≤ 1 % of them keep"],
    ["Measure", p.measured_at ? `on the whole table · ${fmtDateTime(p.measured_at)}` : "not yet", p.measured_at ? "done" : "todo", "measure: drops per approach on the whole table, and samples of drops to check (Results tab)"],
    pdStep(),
  ];
  $("#pf-stats").replaceChildren(h("ol", { class: "pf-pipeline", "aria-label": "Study pipeline" },
    ...steps.map(([name, detail, status, tip]) => h("li", { class: `pf-step ${status}`, title: tip }, h("b", {}, name), h("small", {}, detail)))));
}

function pfRenderControls() {
  const data = pf.data;
  pfRenderPipeline();
  if (!data || data.missing) {
    $("#pf-progress").replaceChildren(h("b", {}, "No labels yet"), h("small", {}, "Run uv run --locked scripts/prefilter.py sample --set train"));
    return;
  }
  const select = $("#pf-set");
  const chosen = select.value;
  select.replaceChildren(h("option", { value: "" }, "All sets"), ...Object.keys(data.progress).map((name) => h("option", { value: name, selected: name === chosen }, pfSetLabel(name))));
  const rows = Object.entries(data.progress).filter(([name]) => !chosen || name === chosen);
  $("#pf-progress").replaceChildren(h("b", {}, `${fmtCount(data.total)} to show`),
    ...rows.map(([name, counts]) => h("small", {}, `${pfSetLabel(name)}: ${fmtCount(counts.checked)} of ${fmtCount(counts.total)} seen by a person`)));
}

async function pfLoadDocuments() {
  const load = ++pf.load;
  const ids = (pf.data?.items || []).map((item) => item.id);
  pf.documents = null;
  pf.failed = null;
  pfRenderLabel(); // at once: no card stays on screen for the previous page
  if (!ids.length) return;
  let rows;
  try {
    rows = (await api("/api/prefilter/documents", { method: "POST", body: JSON.stringify({ ids }) })).rows;
  } catch (error) {
    if (load !== pf.load) return;
    pf.failed = `${error.message}${error.data?.hint ? ` ${error.data.hint}` : ""}`;
    pfRenderLabel();
    return;
  }
  if (load !== pf.load) return; // another page meanwhile
  const found = Object.fromEntries(rows.map((row) => [row.id, row]));
  pf.documents = Object.fromEntries(ids.map((id) => [id, found[id] || null]));
  pfRenderLabel();
}

// The label that counts: a person's, else the LLM's.
const pfCounts = (item) => item.label != null ? [item.label, item.group] : item.proposal ? [item.proposal.label, item.proposal.group] : [null, null];

// Title, source, type and abstract of a card's document `doc` (null: not stored).
function pfDocument(id, doc, { loading = false, failed = false } = {}) {
  const link = doc?.canonical_url || urlFor(id);
  const title = loading ? `Loading ${id} …` : doc?.title || id;
  return [
    h("div", { class: "pf-title" }, link ? h("a", { href: link, target: "_blank", rel: "noopener" }, title) : title),
    doc ? h("div", { class: "pf-meta" }, sourcePill(doc.source),
      ...[typeLabel(doc.content_type), (doc.publication_types || []).join(", "), doc.published_at?.slice(0, 4)].filter(Boolean).map((text) => h("span", {}, text))) : null,
    h("p", { class: "pf-abstract", title: "Click to show all", onclick: (event) => event.currentTarget.classList.toggle("open") },
      loading ? "" : doc ? doc.summary || h("i", {}, "No abstract or description") : h("i", {}, failed ? "Could not load the document." : "No longer stored in this database. You can still label it from its source page.")),
  ];
}

function pfCard(item, position) {
  const doc = pf.documents?.[item.id];
  const loading = !pf.documents && !pf.failed;
  const [label, group] = pfCounts(item);
  const [statusText, statusClass] = PF_STATUS[item.status] || [item.status, "plain"];
  const proposal = item.proposal
    ? h("div", { class: "pf-proposal" }, h("b", {}, `LLM: ${item.proposal.label}${item.proposal.group ? ` (group ${item.proposal.group})` : ""}`), h("span", {}, item.proposal.reason))
    : h("div", { class: "pf-proposal none" }, h("b", {}, "No proposal"), item.proposal_raw ? h("details", {}, h("summary", {}, "Raw answer"), h("pre", {}, item.proposal_raw)) : null);
  // Nothing to label that nobody could see: not while loading, nor when the database failed.
  const blocked = loading || Boolean(pf.failed) || pf.saving.has(item.id);
  const note = h("input", { class: "pf-note", type: "text", maxlength: "500", placeholder: "Note (optional)", value: item.note || "", "aria-label": `Note for ${item.id}` });
  const choices = h("div", { class: "pf-choices", role: "group", "aria-label": "Label" }, ...PF_CHOICES.map(([value, number, text]) =>
    h("button", { type: "button", class: label === value && group === number ? "active" : null, "aria-pressed": String(label === value && group === number), disabled: blocked,
      onclick: () => pfSave(item.id, value, number, note.value) }, text)));
  return h("article", { class: `panel pf-card pf-${label || "none"}`, "data-id": item.id },
    h("h3", {}, h("span", {}, `#${fmtCount(pf.offset + position + 1)}`), h("small", {}, item.sets.map(pfSetLabel).join(" · ")), h("span", { class: "spacer" }),
      h("span", { class: `pill ${statusClass}`, title: item.status === "unchecked" ? "No person has looked at it; the LLM's label counts" : null }, statusText)),
    h("div", { class: "panel-body" }, ...pfDocument(item.id, doc, { loading, failed: Boolean(pf.failed) }), proposal, choices, note));
}

// The first, the last and two pages either side of the current one; "…" for the gaps.
function pfPageNumbers(current, count) {
  const shown = [...new Set([1, count, ...[-2, -1, 0, 1, 2].map((step) => current + step)])].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  return shown.flatMap((n, index) => index && n - shown[index - 1] > 1 ? ["…", n] : [n]);
}

// Pages of `total` cards from `offset`; `goTo(page)` shows another one. Both tabs share the size.
function pfPager(total = pf.data.total, offset = pf.offset, goTo = pfGoTo) {
  const count = Math.max(1, Math.ceil(total / pf.size));
  const current = Math.floor(offset / pf.size) + 1;
  const last = Math.min(offset + pf.size, total);
  const jump = h("input", { type: "number", min: "1", max: String(count), value: String(current), "aria-label": "Page number",
    onchange: (event) => goTo(Number(event.target.value)) });
  return h("nav", { class: "pf-nav", "aria-label": "Pages" },
    h("span", { class: "muted" }, total ? `${fmtCount(offset + 1)}–${fmtCount(last)} of ${fmtCount(total)}` : "0"),
    h("div", { class: "pf-pages" },
      h("button", { type: "button", disabled: current === 1, onclick: () => goTo(current - 1), "aria-label": "Previous page" }, "‹"),
      ...pfPageNumbers(current, count).map((n) => n === "…" ? h("span", { class: "muted" }, "…")
        : h("button", { type: "button", class: n === current ? "active" : null, "aria-current": n === current ? "page" : null, onclick: () => goTo(n) }, String(n))),
      h("button", { type: "button", disabled: current === count, onclick: () => goTo(current + 1), "aria-label": "Next page" }, "›")),
    h("label", { class: "pf-jump" }, "Page ", jump, ` of ${fmtCount(count)}`,
      h("select", { "aria-label": "Documents per page", onchange: (event) => pfResize(Number(event.target.value)) },
        ...PF_SIZES.map((size) => h("option", { value: String(size), selected: size === pf.size }, `${size} per page`)))));
}

function pfRenderLabel() {
  const target = $("#pf-label");
  if (!pf.data || pf.data.missing) { target.replaceChildren(h("div", { class: "empty" }, "No labels file yet.")); return; }
  const guide = h("details", { class: "panel pf-guide" }, h("summary", {}, "Labeling guide"),
    h("table", {}, h("tbody", {}, ...pf.data.guide.map((row) => h("tr", {}, h("td", {}, row.kind), h("td", {}, h("b", {}, row.label)), h("td", { class: "small" }, row.example))))));
  if (!pf.data.items.length) { target.replaceChildren(guide, h("div", { class: "empty" }, "Nothing with this filter.")); return; }
  const failed = pf.failed ? h("div", { class: "panel" }, h("div", { class: "panel-body" },
    h("p", { class: "error" }, `Could not load the documents: ${pf.failed}`),
    h("div", { class: "buttons" }, h("button", { type: "button", onclick: pfLoadDocuments }, "Retry")))) : null;
  target.replaceChildren(...[guide, failed].filter(Boolean), pfPager(), h("div", { class: "pf-grid" }, ...pf.data.items.map(pfCard)), pfPager());
}

async function pfGoTo(page) {
  if (!pf.data || !Number.isFinite(page)) return;
  const count = Math.max(1, Math.ceil(pf.data.total / pf.size));
  pf.offset = (Math.min(Math.max(1, Math.round(page)), count) - 1) * pf.size;
  await pfRefresh();
  $("#pf-label").scrollTop = 0; // after the render: the browser keeps the old position otherwise
}

// A new page size keeps the first document on screen in view, on the tab on screen.
function pfResize(size) {
  try { localStorage.setItem("pf-size", String(size)); } catch { /* only a convenience */ }
  pf.size = size;
  if (pf.tab === "drops") pdGoTo(Math.floor(pd.offset / size) + 1);
  else pfGoTo(Math.floor(pf.offset / size) + 1);
}

function pfRenderCard(id) {
  const position = pf.data.items.findIndex((item) => item.id === id);
  const old = document.querySelector(`#pf-label .pf-card[data-id="${CSS.escape(id)}"]`);
  if (position >= 0 && old) old.replaceWith(pfCard(pf.data.items[position], position));
}

// A saved card stays where it is, even if it no longer matches the filter: nothing jumps away
// under the pointer. Refresh applies the filter again.
async function pfSave(id, label, group, note) {
  const position = pf.data?.items?.findIndex((item) => item.id === id) ?? -1;
  if (position < 0 || !pf.documents || pf.saving.has(id)) return;
  const before = pf.data.items[position];
  pf.saving.add(id);
  pfRenderCard(id);
  try {
    const saved = await api("/api/prefilter/label", { method: "POST", body: JSON.stringify({ id, label, group, note }) });
    $("#pf-error").textContent = "";
    pf.data.items[position] = saved;
    if (before.label == null) for (const name of before.sets) pf.data.progress[name].checked += 1;
    pfRenderControls();
  } catch (error) {
    $("#pf-error").textContent = error.message;
  } finally {
    pf.saving.delete(id);
    pfRenderCard(id);
  }
}

for (const button of document.querySelectorAll("#pf-tabs button")) button.addEventListener("click", () => pfSwitchTab(button.dataset.pftab));
$("#pf-refresh").addEventListener("click", () => (pf.tab === "drops" ? pdRefresh() : pfRefresh()));
for (const filter of ["#pf-set", "#pf-status", "#pf-label-filter"]) $(filter).addEventListener("change", () => { pf.offset = 0; pfRefresh(); });

// ── Drops: the drop list (document_drops). A rule proposes, a person decides; only an accepted
// drop leaves the indexes. Decisions are saved to the database the debug UI is connected to.
// `counts` is null until loaded; `missing` when that database has no drop list table yet.
const pd = { data: null, offset: 0, counts: null, missing: false, failed: null, saving: new Set() };
const PD_STATUS = { proposed: ["proposed", "none"], accepted: ["dropped", "failed"], rejected: ["kept", "ok"] };
const PD_MISSING = "No drop list yet: apply db/init/05-document-drops.sql (make db), then run scripts/prefilter.py propose-drops.";

function pdStep() {
  if (pd.missing) return ["Drops", "no drop list table", "todo", PD_MISSING];
  if (!pd.counts) return ["Drops", pd.failed ? "database unavailable" : "…", "todo", "The drop list of the database the debug UI reads"];
  const { proposed, accepted, rejected } = pd.counts;
  return ["Drops", `${fmtCount(proposed)} to decide · ${fmtCount(accepted)} dropped · ${fmtCount(rejected)} kept`,
    proposed + accepted + rejected === 0 ? "todo" : proposed ? "warn" : "done",
    "propose-drops: a rule proposes; a person drops or keeps each one in the Drops tab. Only a dropped document leaves the indexes"];
}

async function pdLoadCounts() {
  try {
    const data = await api(`/api/prefilter/drops?${queryString({ limit: 1 })}`);
    pd.missing = Boolean(data.missing);
    pd.counts = data.missing ? null : data.counts;
    pd.failed = null;
  } catch (error) {
    pd.counts = null;
    pd.failed = error.message;
  }
  if (pf.data) pfRenderPipeline();
  pdRenderCounts();
}

function pdRenderCounts() {
  const target = $("#pf-drop-counts");
  if (pd.missing) { target.replaceChildren(h("b", {}, "No drop list"), h("small", {}, PD_MISSING)); return; }
  if (!pd.counts) { target.replaceChildren(h("b", {}, pd.failed ? "Database unavailable" : "Loading …"), pd.failed ? h("small", {}, pd.failed) : null); return; }
  target.replaceChildren(h("b", {}, `${fmtCount(pd.counts.proposed)} to decide`),
    h("small", {}, `${fmtCount(pd.counts.accepted)} dropped`), h("small", {}, `${fmtCount(pd.counts.rejected)} kept`));
}

async function pdRefresh() {
  const filter = { status: $("#pf-drop-status").value, proposed_by: $("#pf-drop-proposer").value };
  try {
    pd.data = await api(`/api/prefilter/drops?${queryString({ ...filter, limit: pf.size, offset: pd.offset })}`);
    $("#pf-error").textContent = "";
  } catch (error) {
    pd.data = null;
    $("#pf-error").textContent = error.message;
  }
  if (pd.data && !pd.data.missing && !pd.data.items.length && pd.offset > 0) {
    pd.offset = Math.max(0, Math.floor((pd.data.total - 1) / pf.size) * pf.size);
    return pdRefresh();
  }
  if (pd.data && !pd.data.missing) {
    const select = $("#pf-drop-proposer");
    const chosen = select.value;
    select.replaceChildren(h("option", { value: "" }, "All"), ...pd.data.proposers.map((name) => h("option", { value: name, selected: name === chosen }, name)));
    pd.counts = pd.data.counts;
  }
  pd.missing = Boolean(pd.data?.missing);
  pdRenderCounts();
  if (pf.data) pfRenderPipeline();
  pdRender();
}

function pdCard(item, position) {
  const [statusText, statusClass] = PD_STATUS[item.status] || [item.status, "plain"];
  const busy = pd.saving.has(item.id);
  const note = h("input", { class: "pf-note", type: "text", maxlength: "500", placeholder: "Note (optional)", value: item.note || "", "aria-label": `Note for ${item.id}` });
  const decide = (decision) => pdSave([item.id], decision, note.value);
  const buttons = item.status === "proposed"
    ? [h("button", { type: "button", class: "pd-drop", disabled: busy, onclick: () => decide("accept") }, "Drop"),
      h("button", { type: "button", disabled: busy, onclick: () => decide("reject") }, "Keep")]
    : [h("button", { type: "button", disabled: busy, onclick: () => decide("undo") }, "Undo")];
  return h("article", { class: `panel pf-card pd-${item.status}`, "data-id": item.id },
    h("h3", {}, h("span", {}, `#${fmtCount(pd.offset + position + 1)}`), h("small", {}, item.proposed_by), h("span", { class: "spacer" }),
      h("span", { class: `pill ${statusClass}` }, statusText)),
    h("div", { class: "panel-body" }, ...pfDocument(item.id, item),
      h("div", { class: "pf-proposal" }, h("b", {}, "Why proposed"), h("span", {}, item.reason)),
      h("div", { class: "pf-choices", role: "group", "aria-label": "Decision" }, ...buttons), note));
}

function pdRender() {
  const target = $("#pf-drops");
  if (!pd.data) { target.replaceChildren(h("div", { class: "empty" }, "Could not load the drop list.")); return; }
  if (pd.data.missing) { target.replaceChildren(h("div", { class: "empty" }, PD_MISSING)); return; }
  if (!pd.data.items.length) { target.replaceChildren(h("div", { class: "empty" }, "Nothing with this filter.")); return; }
  const open = pd.data.items.filter((item) => item.status === "proposed").map((item) => item.id);
  const pageAction = (text, armed, decision) => h("button", { type: "button", disabled: !open.length,
    onclick: (event) => armOrRun(event.currentTarget, armed, () => pdSave(open, decision)) }, text);
  const actions = h("div", { class: "pd-actions" },
    h("span", { class: "muted" }, open.length ? `${fmtCount(open.length)} to decide on this page` : "Everything on this page is decided"),
    pageAction("Drop all on this page", `Click again to drop ${open.length}`, "accept"),
    pageAction("Keep all on this page", `Click again to keep ${open.length}`, "reject"));
  target.replaceChildren(actions, pfPager(pd.data.total, pd.offset, pdGoTo),
    h("div", { class: "pf-grid" }, ...pd.data.items.map(pdCard)), pfPager(pd.data.total, pd.offset, pdGoTo));
}

async function pdGoTo(page) {
  if (!pd.data || pd.data.missing || !Number.isFinite(page)) return;
  const count = Math.max(1, Math.ceil(pd.data.total / pf.size));
  pd.offset = (Math.min(Math.max(1, Math.round(page)), count) - 1) * pf.size;
  await pdRefresh();
  $("#pf-drops").scrollTop = 0;
}

// The decided cards stay where they are, with the state the server stored: nothing jumps away
// under the pointer. Refresh applies the filter again.

async function pdSave(ids, decision, note) {
  if (!pd.data?.items || ids.some((id) => pd.saving.has(id))) return;
  for (const id of ids) pd.saving.add(id);
  pdRender();
  try {
    const saved = await api("/api/prefilter/drops", { method: "POST", body: JSON.stringify({ ids, decision, ...(note != null ? { note } : {}) }) });
    $("#pf-error").textContent = "";
    // What is stored, also where another person decided meanwhile and nothing changed here.
    for (const item of pd.data.items) {
      if (!ids.includes(item.id) || !(item.id in saved.statuses)) continue;
      item.status = saved.statuses[item.id];
      if (note != null) item.note = note.trim();
    }
  } catch (error) {
    $("#pf-error").textContent = error.message;
  } finally {
    for (const id of ids) pd.saving.delete(id);
    pdRender();
    pdLoadCounts();
  }
}

for (const filter of ["#pf-drop-status", "#pf-drop-proposer"]) $(filter).addEventListener("change", () => { pd.offset = 0; pdRefresh(); });

// ── Results: what scripts/prefilter.py measure wrote, against the success criteria of #92 ──
const PF_APPROACH = { rules: "Rules", "rules+model": "Rules + classifier" };
const pfPercent = (share) => share == null ? "–" : `${(100 * share).toFixed(1)} %`;
const pfBadge = (ok, label, tip) => h("span", { class: `pill ${ok ? "ok" : "failed"}`, title: tip }, `${ok ? "✓" : "✗"} ${label}`);

async function pfResults() {
  const target = $("#pf-results");
  let result;
  try {
    result = await api("/api/prefilter/results");
  } catch (error) {
    target.replaceChildren(h("div", { class: "error" }, error.message));
    return;
  }
  if (result.missing) {
    target.replaceChildren(h("div", { class: "empty" }, "No results yet. Run uv run --locked scripts/prefilter.py measure first."));
    return;
  }
  const approaches = Object.entries(result.approaches).map(([name, data]) => data
    ? h("div", { class: "panel" }, h("h3", {}, PF_APPROACH[name] || name, data.extrapolated ? h("small", { title: "Classifier drops are counted on the embedded documents and scaled per source" }, "estimate") : null),
      h("div", { class: "panel-body" },
        h("div", { class: "stats pf-cards" },
          card("Dropped", `${fmtCount(data.dropped)} · ${pfPercent(data.share)}`),
          card(`Checked drops, ${fmtCount(data.by_person ?? 0)} by a person`, fmtCount(data.checked)),
          card("Wrong drops", fmtCount(data.wrong), data.wrong > 1 ? "bad" : ""),
          card("Upper bound (95 %)", pfPercent(data.upper_bound)),
          data.cannot_judge != null ? card("Cannot judge (no embedding)", fmtCount(data.cannot_judge), "muted") : null),
        h("div", { class: "pf-badges" },
          pfBadge(data.passes.safety, "Safety", "At least 300 checked drops, at most 1 of them wrong. A drop counts as checked when it has a label, from the LLM or a person"),
          pfBadge(data.passes.usefulness_2, "≥ 2 % dropped"),
          pfBadge(data.passes.usefulness_3, "≥ 3 % dropped")),
        barList(Object.entries(data.by_source).map(([source, n]) => ({ name: SOURCE_LABEL[source] || source, value: n })))))
    : h("div", { class: "panel" }, h("h3", {}, PF_APPROACH[name] || name), h("div", { class: "panel-body" }, h("span", { class: "hint" }, result.model ? `The classifier (trained on ${fmtCount(result.model.trained_on)}) found no safe threshold, so it drops nothing.` : "No classifier yet: run train."))));
  const rules = h("div", { class: "panel" }, h("h3", {}, "Each rule", h("small", {}, "a variant is only reported, not part of the rules")),
    h("table", {}, h("thead", {}, h("tr", {}, ...["Rule", "Dropped", "By source", "Checked", "Wrong", "Query"].map((title) => h("th", {}, title)))),
      h("tbody", {}, ...Object.entries(result.rules).map(([name, rule]) => h("tr", { class: rule.variant ? "pf-variant" : "" },
        h("td", {}, name.replaceAll("_", " "), rule.variant ? h("small", {}, " variant") : null),
        h("td", { class: "num" }, fmtCount(rule.dropped)),
        h("td", { class: "small" }, Object.entries(rule.by_source).map(([source, n]) => `${SOURCE_LABEL[source] || source} ${fmtCount(n)}`).join(" · ") || "–"),
        h("td", { class: "num" }, rule.variant ? "–" : fmtCount(rule.checked)),
        h("td", { class: `num${rule.wrong > 0 ? " bad" : ""}` }, rule.variant ? "–" : fmtCount(rule.wrong)),
        h("td", { class: "num" }, fmtSeconds(rule.seconds)))))));
  const model = result.model;
  const facts = h("div", { class: "panel" }, h("h3", {}, "Classifier, labels and speed"),
    h("div", { class: "panel-body" },
      model?.stale ? h("span", { class: "hint" }, "The training labels changed since the classifier was trained: run train, then measure.") : null,
      h("div", { class: "stats pf-cards" },
        card("Threshold (probability of keep)", model?.threshold == null ? "–" : model.threshold.toFixed(3), model ? "" : "muted"),
        card(model?.by_person != null ? `Trained on, ${fmtCount(model.by_person)} labeled by a person` : "Trained on", model ? fmtCount(model.trained_on) : "–", model ? "" : "muted"),
        card("Training labels below threshold", model ? fmtCount(model.below_threshold) : "–", model ? "" : "muted"),
        // Agreement says little on a few labels: muted below 30.
        h("div", { class: `card${result.llm_agreement.checked < 30 ? " muted" : ""}`, title: result.llm_agreement.checked < 30 ? "Too few labels by a person to judge the LLM" : null },
          h("b", {}, `${fmtCount(result.llm_agreement.agreed)} / ${fmtCount(result.llm_agreement.checked)}`), h("span", {}, "LLM label kept by a person")),
        card(`Unhelpful in the random sample: ${fmtCount(result.random.unhelpful)} of ${fmtCount(result.random.checked)}`, pfPercent(result.random.checked ? result.random.unhelpful / result.random.checked : null)),
        card("Rules, whole table", fmtSeconds(result.timing.rules_seconds)),
        card("Classifier per document", result.timing.model_ms_per_document == null ? "–" : `${result.timing.model_ms_per_document.toFixed(3)} ms`)),
      h("small", { class: "muted" }, `Measured ${fmtDateTime(result.generated_at)} on ${fmtCount(result.total)} documents. Random sample: group 1 ${result.random.by_group["1"]}, group 2 ${result.random.by_group["2"]}.`)));
  target.replaceChildren(...approaches, rules, facts);
}
