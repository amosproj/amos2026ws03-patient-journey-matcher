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

function pfShow() {
  history.replaceState(null, "", pf.tab === "results" ? "#prefilter-results" : "#prefilter");
  pfSwitchTab(pf.tab);
  pfRefresh();
}

function pfSwitchTab(tab) {
  pf.tab = tab;
  $("#pftab-label").hidden = tab !== "label";
  $("#pftab-results").hidden = tab !== "results";
  for (const button of document.querySelectorAll("#pf-tabs button")) button.classList.toggle("active", button.dataset.pftab === tab);
  if (state.screen === "prefilter") history.replaceState(null, "", tab === "results" ? "#prefilter-results" : "#prefilter");
  if (tab === "results" && typeof pfResults === "function") pfResults();
}

async function pfRefresh() {
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

function pfCard(item, position) {
  const doc = pf.documents?.[item.id];
  const loading = !pf.documents && !pf.failed;
  const [label, group] = pfCounts(item);
  const [statusText, statusClass] = PF_STATUS[item.status] || [item.status, "plain"];
  const link = doc?.canonical_url || urlFor(item.id);
  const title = loading ? `Loading ${item.id} …` : doc?.title || item.id;
  const abstract = h("p", { class: "pf-abstract", title: "Click to show all", onclick: (event) => event.currentTarget.classList.toggle("open") },
    loading ? "" : doc ? doc.summary || h("i", {}, "No abstract or description") : h("i", {}, pf.failed ? "Could not load the document." : "No longer stored in this database. You can still label it from its source page."));
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
    h("div", { class: "panel-body" },
      h("div", { class: "pf-title" }, link ? h("a", { href: link, target: "_blank", rel: "noopener" }, title) : title),
      doc ? h("div", { class: "pf-meta" }, sourcePill(doc.source),
        ...[typeLabel(doc.content_type), (doc.publication_types || []).join(", "), doc.published_at?.slice(0, 4)].filter(Boolean).map((text) => h("span", {}, text))) : null,
      abstract, proposal, choices, note));
}

// The first, the last and two pages either side of the current one; "…" for the gaps.
function pfPageNumbers(current, count) {
  const shown = [...new Set([1, count, ...[-2, -1, 0, 1, 2].map((step) => current + step)])].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b);
  return shown.flatMap((n, index) => index && n - shown[index - 1] > 1 ? ["…", n] : [n]);
}

function pfPager() {
  const total = pf.data.total;
  const count = Math.max(1, Math.ceil(total / pf.size));
  const current = Math.floor(pf.offset / pf.size) + 1;
  const last = Math.min(pf.offset + pf.size, total);
  const jump = h("input", { type: "number", min: "1", max: String(count), value: String(current), "aria-label": "Page number",
    onchange: (event) => pfGoTo(Number(event.target.value)) });
  return h("nav", { class: "pf-nav", "aria-label": "Pages" },
    h("span", { class: "muted" }, total ? `${fmtCount(pf.offset + 1)}–${fmtCount(last)} of ${fmtCount(total)}` : "0"),
    h("div", { class: "pf-pages" },
      h("button", { type: "button", disabled: current === 1, onclick: () => pfGoTo(current - 1), "aria-label": "Previous page" }, "‹"),
      ...pfPageNumbers(current, count).map((n) => n === "…" ? h("span", { class: "muted" }, "…")
        : h("button", { type: "button", class: n === current ? "active" : null, "aria-current": n === current ? "page" : null, onclick: () => pfGoTo(n) }, String(n))),
      h("button", { type: "button", disabled: current === count, onclick: () => pfGoTo(current + 1), "aria-label": "Next page" }, "›")),
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

// A new page size keeps the first document on screen in view.
function pfResize(size) {
  try { localStorage.setItem("pf-size", String(size)); } catch { /* only a convenience */ }
  pf.size = size;
  pfGoTo(Math.floor(pf.offset / size) + 1);
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
$("#pf-refresh").addEventListener("click", pfRefresh);
for (const filter of ["#pf-set", "#pf-status", "#pf-label-filter"]) $(filter).addEventListener("change", () => { pf.offset = 0; pfRefresh(); });

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
          card("Checked drops", fmtCount(data.checked)),
          card("Wrong drops", fmtCount(data.wrong), data.wrong > 1 ? "bad" : ""),
          card("Upper bound (95 %)", pfPercent(data.upper_bound)),
          data.cannot_judge != null ? card("Cannot judge (no embedding)", fmtCount(data.cannot_judge), "muted") : null),
        h("div", { class: "pf-badges" },
          pfBadge(data.passes.safety, "Safety", "At least 300 checked drops, at most 1 of them wrong"),
          pfBadge(data.passes.usefulness_2, "≥ 2 % dropped"),
          pfBadge(data.passes.usefulness_3, "≥ 3 % dropped")),
        barList(Object.entries(data.by_source).map(([source, n]) => ({ name: SOURCE_LABEL[source] || source, value: n })))))
    : h("div", { class: "panel" }, h("h3", {}, PF_APPROACH[name] || name), h("div", { class: "panel-body" }, h("span", { class: "hint" }, "No classifier with a threshold yet: run train."))));
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
        card("Trained on", model ? fmtCount(model.trained_on) : "–", model ? "" : "muted"),
        card("Training labels below threshold", model ? fmtCount(model.below_threshold) : "–", model ? "" : "muted"),
        ...Object.entries(result.llm_agreement.by_model || { all: result.llm_agreement }).map(([name, counts]) =>
          card(`${name.split("@")[0]} agreed with people`, `${fmtCount(counts.agreed)} / ${fmtCount(counts.checked)}`)),
        card("Unhelpful in the random sample", `${fmtCount(result.random.unhelpful)} / ${fmtCount(result.random.checked)}`),
        card("Rules, whole table", fmtSeconds(result.timing.rules_seconds)),
        card("Classifier per document", result.timing.model_ms_per_document == null ? "–" : `${result.timing.model_ms_per_document.toFixed(3)} ms`)),
      h("small", { class: "muted" }, `Measured ${fmtDateTime(result.generated_at)} on ${fmtCount(result.total)} documents. Random sample: group 1 ${result.random.by_group["1"]}, group 2 ${result.random.by_group["2"]}.`)));
  target.replaceChildren(...approaches, rules, facts);
}
