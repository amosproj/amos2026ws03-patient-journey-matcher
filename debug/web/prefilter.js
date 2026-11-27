"use strict";
// ── Pre-filter: check the LLM's proposed labels of the document pre-filter study (#92) ──
// The labels live in research/prefilter/labels.json; a document's fields come from the database,
// read only. A document that is no longer stored can still be labeled.
// `offset` is where the loaded page of the filter starts; `rendered` the id whose document is on
// screen and ready, the only one a button or key may label.
const PF_PAGE = 500;
const pf = { tab: "label", data: null, offset: 0, index: 0, document: null, rendered: null, loading: false, saving: false };
const PF_SET_LABEL = { train: "Training", random: "Random test", "drops-rules": "Rule drops", "drops-model": "Model drops" };
const pfSetLabel = (name) => PF_SET_LABEL[name] || (name.startsWith("drops-rule:") ? `Drops of ${name.slice(11)}` : name.startsWith("drops-model:") ? `Model drops ${name.slice(12)}`.trim() : name);

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
  try {
    pf.data = await api(`/api/prefilter/labels?${queryString({ set: $("#pf-set").value, status: $("#pf-status").value, limit: PF_PAGE, offset: pf.offset })}`);
    $("#pf-error").textContent = "";
  } catch (error) {
    pf.data = null;
    $("#pf-error").textContent = error.message;
  }
  pf.index = Math.min(pf.index, Math.max(0, (pf.data?.items?.length || 1) - 1));
  pfRenderControls();
  await pfLoadDocument();
}

function pfRenderControls() {
  const data = pf.data;
  if (!data || data.missing) {
    $("#pf-progress").replaceChildren(h("b", {}, "No labels yet"), h("small", {}, "Run uv run --locked scripts/prefilter.py sample --set train"));
    return;
  }
  const select = $("#pf-set");
  const chosen = select.value;
  select.replaceChildren(h("option", { value: "" }, "All sets"), ...Object.keys(data.progress).map((name) => h("option", { value: name, selected: name === chosen }, pfSetLabel(name))));
  const rows = Object.entries(data.progress).filter(([name]) => !chosen || name === chosen);
  $("#pf-progress").replaceChildren(h("b", {}, `${fmtCount(data.total)} to show`),
    ...rows.map(([name, counts]) => h("small", {}, `${pfSetLabel(name)}: checked ${fmtCount(counts.checked)} / ${fmtCount(counts.total)}`)));
}

function pfCurrent() { return pf.data?.items?.[pf.index] || null; }

async function pfLoadDocument() {
  const item = pfCurrent();
  pf.document = null;
  pf.rendered = null;
  pf.loading = Boolean(item);
  pfRenderLabel(); // at once: no button stays on screen for the previous document
  if (!item) return;
  let document;
  try {
    document = (await api(`/api/db/document?id=${encodeURIComponent(item.id)}`)).document;
  } catch (error) {
    document = { missing: error.message };
  }
  if (pfCurrent()?.id !== item.id) return; // moved on meanwhile
  pf.document = document;
  pf.loading = false;
  pf.rendered = item.id;
  pfRenderLabel();
}

function pfRenderLabel() {
  const item = pfCurrent();
  const target = $("#pf-label");
  if (!pf.data || pf.data.missing) { target.replaceChildren(h("div", { class: "empty" }, "No labels file yet.")); return; }
  if (!item) { target.replaceChildren(h("div", { class: "empty" }, "Nothing left with this filter.")); return; }
  if (pf.loading) { target.replaceChildren(h("div", { class: "empty" }, `Loading ${item.id} …`)); return; }
  const doc = pf.document || {};
  const proposal = item.proposal;
  const link = doc.canonical_url || urlFor(item.id);
  const head = h("h3", {}, h("span", {}, `${fmtCount(pf.offset + pf.index + 1)} of ${fmtCount(pf.data.total)}`), h("small", {}, item.sets.map(pfSetLabel).join(" · ")), h("span", { class: "spacer" }),
    h("span", { class: `pill ${item.status === "unchecked" ? "none" : item.status === "accepted" ? "ok" : "plain"}` }, item.status));
  const body = doc.missing
    ? [h("p", { class: "hint" }, "No longer stored in this database. You can still label it from its source page."), h("p", {}, h("b", {}, item.id))]
    : [
      h("div", { class: "pf-title" }, doc.title || item.id),
      h("div", { class: "pf-meta" }, doc.source ? sourcePill(doc.source) : null,
        ...[typeLabel(doc.content_type), (doc.publication_types || []).join(", "), doc.published_at?.slice(0, 4)].filter(Boolean).map((text) => h("span", {}, text))),
      h("p", { class: "pf-abstract" }, doc.summary || h("i", {}, "No abstract or description")),
    ];
  const said = proposal
    ? h("div", { class: "pf-proposal" }, h("b", {}, `LLM proposes: ${proposal.label}${proposal.group ? ` (group ${proposal.group})` : ""}`), h("span", {}, proposal.reason))
    : h("div", { class: "pf-proposal none" }, h("b", {}, "No proposal"), item.proposal_raw ? h("details", {}, h("summary", {}, "Raw answer"), h("pre", {}, item.proposal_raw)) : null);
  const note = h("input", { id: "pf-note", type: "text", maxlength: "500", placeholder: "Note (optional)", value: item.note || "" });
  const buttons = h("div", { class: "buttons" },
    h("button", { type: "button", class: "primary", disabled: !proposal || pf.saving, onclick: () => pfSave(item.id, proposal.label, proposal.group) }, "Accept"),
    h("button", { type: "button", disabled: pf.saving, onclick: () => pfSave(item.id, "keep", null) }, "Keep"),
    h("button", { type: "button", disabled: pf.saving, onclick: () => pfSave(item.id, "unhelpful", 1) }, "Unhelpful (1)"),
    h("button", { type: "button", disabled: pf.saving, onclick: () => pfSave(item.id, "unhelpful", 2) }, "Unhelpful (2)"));
  const nav = h("div", { class: "pf-nav" },
    h("button", { type: "button", class: "link-button", disabled: pf.offset + pf.index === 0, onclick: () => pfMove(-1) }, "← Previous"),
    link ? h("a", { href: link, target: "_blank", rel: "noopener" }, "Source page ↗") : null,
    h("button", { type: "button", class: "link-button", disabled: pf.offset + pf.index >= pf.data.total - 1, onclick: () => pfMove(1) }, "Next →"));
  const guide = h("details", { class: "panel pf-guide" }, h("summary", {}, "Labeling guide"),
    h("table", {}, h("tbody", {}, ...pf.data.guide.map((row) => h("tr", {}, h("td", {}, row.kind), h("td", {}, h("b", {}, row.label)), h("td", { class: "small" }, row.example))))));
  target.replaceChildren(guide, h("div", { class: "panel" }, head, h("div", { class: "panel-body" }, ...body, said, note, buttons, nav)));
}

// Past the loaded page, the next or previous page of the filter is fetched.
function pfMove(step) {
  if (!pf.data?.items) return;
  const target = pf.index + step;
  if (target >= pf.data.items.length && pf.offset + pf.data.items.length < pf.data.total) {
    pf.offset += pf.data.items.length;
    pf.index = 0;
    pfRefresh();
  } else if (target < 0 && pf.offset > 0) {
    pf.offset = Math.max(0, pf.offset - PF_PAGE);
    pf.index = PF_PAGE - 1;
    pfRefresh();
  } else {
    pf.index = Math.max(0, Math.min(target, pf.data.items.length - 1));
    pfLoadDocument();
  }
}

async function pfSave(id, label, group) {
  const item = pfCurrent();
  // Only the document on screen: never one still loading or reached by a click meanwhile.
  if (!item || item.id !== id || pf.rendered !== id || pf.loading || pf.saving) return;
  pf.saving = true;
  try {
    const saved = await api("/api/prefilter/label", { method: "POST", body: JSON.stringify({ id: item.id, label, group, note: $("#pf-note")?.value || "" }) });
    $("#pf-error").textContent = "";
    // Unchecked filter: the saved one leaves the list, so the next one moves up to this place.
    if ($("#pf-status").value === "unchecked") { pf.data.items.splice(pf.index, 1); pf.data.total -= 1; }
    else { pf.data.items[pf.index] = saved; pf.index += 1; }
    for (const name of item.sets) if (item.label == null) pf.data.progress[name].checked += 1;
    pf.saving = false;
    // The loaded page is used up but the filter has more: fetch the next ones.
    if (pf.index >= pf.data.items.length && pf.offset + pf.data.items.length < pf.data.total) {
      if ($("#pf-status").value !== "unchecked") pf.offset += pf.data.items.length;
      pf.index = 0;
      await pfRefresh();
      return;
    }
    pf.index = Math.min(pf.index, Math.max(0, pf.data.items.length - 1));
    pfRenderControls();
  } catch (error) {
    $("#pf-error").textContent = error.message;
  } finally {
    pf.saving = false;
  }
  await pfLoadDocument();
}

document.addEventListener("keydown", (event) => {
  if (state.screen !== "prefilter" || pf.tab !== "label" || event.target.closest("input, select, textarea")) return;
  // Not with a modifier (Cmd+A, Ctrl+1 …) and not while a key is held down.
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  const item = pfCurrent();
  if (!item || item.id !== pf.rendered) return;
  const proposal = item.proposal;
  const actions = { a: () => proposal && pfSave(item.id, proposal.label, proposal.group), k: () => pfSave(item.id, "keep", null), 1: () => pfSave(item.id, "unhelpful", 1), 2: () => pfSave(item.id, "unhelpful", 2), n: () => pfMove(1) };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
for (const button of document.querySelectorAll("#pf-tabs button")) button.addEventListener("click", () => pfSwitchTab(button.dataset.pftab));
$("#pf-refresh").addEventListener("click", pfRefresh);
$("#pf-set").addEventListener("change", () => { pf.offset = 0; pf.index = 0; pfRefresh(); });
$("#pf-status").addEventListener("change", () => { pf.offset = 0; pf.index = 0; pfRefresh(); });

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
        card("LLM agreed with people", `${fmtCount(result.llm_agreement.agreed)} / ${fmtCount(result.llm_agreement.checked)}`),
        card("Unhelpful in the random sample", `${fmtCount(result.random.unhelpful)} / ${fmtCount(result.random.checked)}`),
        card("Rules, whole table", fmtSeconds(result.timing.rules_seconds)),
        card("Classifier per document", result.timing.model_ms_per_document == null ? "–" : `${result.timing.model_ms_per_document.toFixed(3)} ms`)),
      h("small", { class: "muted" }, `Measured ${fmtDateTime(result.generated_at)} on ${fmtCount(result.total)} documents. Random sample: group 1 ${result.random.by_group["1"]}, group 2 ${result.random.by_group["2"]}.`)));
  target.replaceChildren(...approaches, rules, facts);
}
