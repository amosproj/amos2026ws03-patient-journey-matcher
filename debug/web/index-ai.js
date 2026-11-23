"use strict";
// ── Index › AI: the index of each model of the AI approach ──
const ai = { data: null, loading: false };
const aiTechnique = () => $("#ai-technique").value;
const aiName = (model) => model === "qwen" ? "Qwen" : "BGE-M3";
// What a document is in the index of a model: the first two are done, the next run embeds the third.
const AI_STATES = [
  ["indexed", "Embedded", "--good", "Has a vector of its title, abstract or description and subjects"],
  ["empty", "No text", "--dropped", "Has no title, abstract, description or subjects: nothing to embed"],
  ["pending", "New or changed", "--pending", "Open: not embedded yet, or changed since; the next run embeds it"],
];

// Both models come with every answer: the Index overview shows them, whatever this screen's choice is.
async function aiRefresh() {
  if (ai.loading) return;
  ai.loading = true;
  try {
    ai.data = await api("/api/index?technique=semantic");
    if (ix.overview) ix.overview.indexer = ai.data.indexer;
    $("#ai-error").textContent = ai.data.indexer.missing || "";
    renderAi();
    renderIxButtons();
    renderIxStats();
    await ixFollowRun();
  } catch (error) {
    ai.data = null;
    $("#ai-error").textContent = error.message;
    $("#ai-start").disabled = true;
  } finally {
    ai.loading = false;
    renderIxButtons();
  }
}

// This screen: both models, or the one chosen here.
function renderAi() {
  if (!ai.data) return;
  const models = ai.data.models.filter((model) => aiTechnique() === "semantic" || model.model === aiTechnique());
  $("#ai-technique").disabled = ai.data.indexer.run?.status === "running";
  const ready = models.every((model) => model.ready && !model.pending);
  $("#ai-state").replaceChildren(h("b", {}, ready ? "Up to date" : "Index build needed"),
    ...models.map((model) => h("small", {}, `${aiName(model.model)}: ${fmtCount(model.indexed)} embedded, ${fmtCount(model.pending)} pending`)));
  $("#ai-stats").replaceChildren(card("Documents", fmtCount(models[0]?.documents ?? 0)),
    ...models.flatMap((model) => [
      card(`${aiName(model.model)} embedded`, fmtCount(model.indexed)),
      card(`${aiName(model.model)} pending`, fmtCount(model.pending)),
      card(`${aiName(model.model)} empty metadata`, fmtCount(model.empty)),
      card(`${aiName(model.model)} index`, model.ready ? "Ready" : "Building"),
    ]));
  $("#ai-coverage").replaceChildren(...models.map(aiCoveragePanel));
}

// One model on the Index overview: how far its index is, in the form of the keyword index next to it.
function aiOverviewPart(model) {
  const done = model.indexed + model.empty;
  return h("div", {},
    h("h3", { title: model.repository }, aiName(model.model)),
    h("b", { class: `ov-total${model.ready ? "" : " muted"}` }, done ? `${fmtShare(done, model.documents)} done` : "no index yet"),
    ovList(AI_STATES.map(([key, label, color, tip]) => ovShare(label, model[key], model.documents, { color, tip, onclick: () => showScreen("ai") }))),
    // match_journey answers NOT_AVAILABLE for a model until its first build went through.
    done && !model.ready ? h("small", { class: "ov-note warn" }, "First build unfinished: no matches yet") : null);
}

function aiCoveragePanel(model) {
  const headings = ["Source", "Content type", "Documents", "Embedded", "Pending", "Empty metadata"];
  const rows = model.coverage.map((row) => h("tr", {},
    h("td", {}, row.source), h("td", {}, row.content_type),
    ...["documents", "indexed", "pending", "empty"].map((key) => h("td", { class: "num" }, fmtCount(row[key])))));
  return h("div", { class: "panel" },
    h("h3", {}, aiName(model.model), h("small", {}, model.repository)),
    h("table", {}, h("thead", {}, h("tr", {}, ...headings.map((label) => h("th", {}, label)))), h("tbody", {}, ...rows)));
}

function aiSwitchTab(tab) {
  $("#aitab-coverage").hidden = tab !== "coverage";
  $("#aitab-log").hidden = tab !== "log";
  for (const button of document.querySelectorAll("#ai-tabs button")) button.classList.toggle("active", button.dataset.aitab === tab);
}

$("#ai-technique").addEventListener("change", async () => {
  renderAi();
  // The log again: it holds the lines of the chosen model only.
  ix.run = null;
  await ixFollowRun();
});
$("#ai-refresh").addEventListener("click", () => aiRefresh());
$("#ai-start").addEventListener("click", () => ixCommand("/api/index/run", { technique: aiTechnique() }));
$("#ai-stop").addEventListener("click", () => ixCommand("/api/index/cancel"));
for (const button of document.querySelectorAll("#ai-tabs button")) button.addEventListener("click", () => aiSwitchTab(button.dataset.aitab));
setInterval(() => { if (ixAutoRefresh("ai", "#ai-auto")) aiRefresh(); }, 5000);
