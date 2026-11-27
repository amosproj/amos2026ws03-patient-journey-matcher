"use strict";
// ── Pre-filter: check the LLM's proposed labels of the document pre-filter study (#92) ──
// The labels live in research/prefilter/labels.json; a document's fields come from the database,
// read only. A document that is no longer stored can still be labeled.
const pf = { tab: "label", data: null, index: 0, document: null, documentId: null, saving: false };
const PF_SET_LABEL = { train: "Training", random: "Random test", "drops-rules": "Rule drops", "drops-model": "Model drops" };
const pfSetLabel = (name) => PF_SET_LABEL[name] || (name.startsWith("drops-rule:") ? `Drops of ${name.slice(11)}` : name);

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
    pf.data = await api(`/api/prefilter/labels?${queryString({ set: $("#pf-set").value, status: $("#pf-status").value, limit: 500 })}`);
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
  pf.documentId = item?.id || null;
  if (item) {
    try {
      pf.document = (await api(`/api/db/document?id=${encodeURIComponent(item.id)}`)).document;
    } catch (error) {
      pf.document = { missing: error.message };
    }
  }
  if (pf.documentId === (item?.id || null)) pfRenderLabel();
}

function pfRenderLabel() {
  const item = pfCurrent();
  const target = $("#pf-label");
  if (!pf.data || pf.data.missing) { target.replaceChildren(h("div", { class: "empty" }, "No labels file yet.")); return; }
  if (!item) { target.replaceChildren(h("div", { class: "empty" }, "Nothing left with this filter.")); return; }
  const doc = pf.document || {};
  const proposal = item.proposal;
  const link = doc.canonical_url || urlFor(item.id);
  const head = h("h3", {}, h("span", {}, `${pf.index + 1} of ${fmtCount(pf.data.items.length)}`), h("small", {}, item.sets.map(pfSetLabel).join(" · ")), h("span", { class: "spacer" }),
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
    h("button", { type: "button", class: "primary", disabled: !proposal || pf.saving, onclick: () => pfSave(proposal.label, proposal.group) }, "Accept"),
    h("button", { type: "button", disabled: pf.saving, onclick: () => pfSave("keep", null) }, "Keep"),
    h("button", { type: "button", disabled: pf.saving, onclick: () => pfSave("unhelpful", 1) }, "Unhelpful (1)"),
    h("button", { type: "button", disabled: pf.saving, onclick: () => pfSave("unhelpful", 2) }, "Unhelpful (2)"));
  const nav = h("div", { class: "pf-nav" },
    h("button", { type: "button", class: "link-button", disabled: pf.index === 0, onclick: () => pfMove(-1) }, "← Previous"),
    link ? h("a", { href: link, target: "_blank", rel: "noopener" }, "Source page ↗") : null,
    h("button", { type: "button", class: "link-button", disabled: pf.index >= pf.data.items.length - 1, onclick: () => pfMove(1) }, "Next →"));
  const guide = h("details", { class: "panel pf-guide" }, h("summary", {}, "Labeling guide"),
    h("table", {}, h("tbody", {}, ...pf.data.guide.map((row) => h("tr", {}, h("td", {}, row.kind), h("td", {}, h("b", {}, row.label)), h("td", { class: "small" }, row.example))))));
  target.replaceChildren(guide, h("div", { class: "panel" }, head, h("div", { class: "panel-body" }, ...body, said, note, buttons, nav)));
}

function pfMove(step) {
  pf.index = Math.max(0, Math.min(pf.index + step, (pf.data?.items?.length || 1) - 1));
  pfLoadDocument();
}

async function pfSave(label, group) {
  const item = pfCurrent();
  if (!item || pf.saving) return;
  pf.saving = true;
  try {
    const saved = await api("/api/prefilter/label", { method: "POST", body: JSON.stringify({ id: item.id, label, group, note: $("#pf-note")?.value || "" }) });
    $("#pf-error").textContent = "";
    // Unchecked filter: the saved one leaves the list, so the next one moves up to this place.
    if ($("#pf-status").value === "unchecked") { pf.data.items.splice(pf.index, 1); pf.data.total -= 1; }
    else { pf.data.items[pf.index] = saved; pf.index += 1; }
    for (const name of item.sets) if (item.label == null) pf.data.progress[name].checked += 1;
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
  const proposal = pfCurrent()?.proposal;
  const actions = { a: () => proposal && pfSave(proposal.label, proposal.group), k: () => pfSave("keep", null), 1: () => pfSave("unhelpful", 1), 2: () => pfSave("unhelpful", 2), n: () => pfMove(1) };
  if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
});
for (const button of document.querySelectorAll("#pf-tabs button")) button.addEventListener("click", () => pfSwitchTab(button.dataset.pftab));
$("#pf-refresh").addEventListener("click", pfRefresh);
$("#pf-set").addEventListener("change", () => { pf.index = 0; pfRefresh(); });
$("#pf-status").addEventListener("change", () => { pf.index = 0; pfRefresh(); });
