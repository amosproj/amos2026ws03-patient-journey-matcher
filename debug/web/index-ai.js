"use strict";
// ── Index › AI: the index of each model of the AI approach ──
const ai = { data: null, loading: false, encoder: null, encoderError: null };
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
    await busyButton($("#ai-refresh"), aiLoad());
  } finally {
    ai.loading = false;
    renderIxButtons();
  }
}

async function aiLoad() {
  try {
    await aiEncoderRefresh();
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
    $("#ai-state").className = "db-conn down";
    $("#ai-state").replaceChildren(h("b", {}, "Not loaded"));
    $("#ai-stats").replaceChildren(card("Documents", "–", "muted"));
    $("#ai-coverage").replaceChildren(h("div", { class: "notice", style: "margin:0" }, error.message));
  }
}

// This screen: both models, or the one chosen here.
function renderAi() {
  if (!ai.data) return;
  const models = ai.data.models.filter((model) => aiTechnique() === "semantic" || model.model === aiTechnique());
  $("#ai-technique").disabled = ai.data.indexer.run?.status === "running";
  const ready = models.every((model) => model.ready && !model.pending);
  $("#ai-state").className = "db-conn";
  $("#ai-state").replaceChildren(h("b", {}, ready ? "Up to date" : "Index build needed"),
    ...models.map((model) => h("small", {}, `${aiName(model.model)}: ${fmtCount(model.indexed)} embedded, ${fmtCount(model.pending)} new or changed`)),
    ...(ai.encoder && ai.encoder.status !== "running" ? [h("span", { class: "hint" }, "Indexing needs the encoder: start it above.")] : []));
  $("#ai-stats").replaceChildren(card("Documents", fmtCount(models[0]?.documents ?? 0)),
    ...models.flatMap((model) => [
      ...AI_STATES.map(([key, label]) => card(`${aiName(model.model)} ${label.toLowerCase()}`, fmtCount(model[key]))),
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
  const rows = model.coverage.map((row) => h("tr", {},
    h("td", {}, sourcePill(row.source)), h("td", {}, typeLabel(row.content_type)),
    ...["documents", ...AI_STATES.map(([key]) => key)].map((key) => h("td", { class: "num" }, fmtCount(row[key])))));
  return h("div", { class: "panel" },
    h("h3", {}, aiName(model.model), h("small", {}, model.repository)),
    h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Source"), h("th", {}, "Content type"), h("th", { class: "num" }, "Documents"),
      ...AI_STATES.map(([, label, , tip]) => h("th", { class: "num", title: tip }, label)))), h("tbody", {}, ...rows)));
}

// ── The encoder: the one this server started, or one of another command such as make debug-ai ──
const AI_ENCODER = {
  running: ["Running", ""],
  starting: ["Starting …", " warn"],
  failed: ["Failed", " down"],
  stopped: ["Not running", " off"],
};

async function aiEncoderRefresh() {
  try {
    ai.encoder = await api("/api/index/encoder");
    ai.encoderError = null;
  } catch (error) {
    ai.encoder = null;
    ai.encoderError = error.message;
  }
  renderAiEncoder();
  renderAi();
  renderIxButtons();
}

function renderAiEncoder() {
  const box = $("#ai-encoder"), encoder = ai.encoder, lines = $("#ai-encoder-lines");
  if (!encoder) {
    box.className = `db-conn${ai.encoderError ? " down" : " loading"}`;
    box.replaceChildren(h("b", {}, ai.encoderError ? "Not loaded" : "Loading …"), ...(ai.encoderError ? [h("small", {}, ai.encoderError)] : []));
    for (const id of ["#ai-encoder-start", "#ai-encoder-stop"]) $(id).disabled = true;
    lines.hidden = true;
    return;
  }
  const { status, own } = encoder, [label, cls] = AI_ENCODER[status];
  box.className = `db-conn${cls}`;
  box.replaceChildren(...[
    h("b", {}, label),
    h("small", { class: "mono" }, `${encoder.url}, ${encoder.device}`),
    status === "starting" ? h("small", {}, `Started ${fmtAgo(encoder.started_at)}. Loading both models; the first start downloads them.`) : null,
    status === "running" && own ? h("small", {}, `Started here ${fmtAgo(encoder.started_at)}; stops with this server.`) : null,
    status === "running" && !own ? h("small", {}, "Started by another command, such as make debug-ai, which stops it.") : null,
    status === "failed" ? h("span", { class: "hint" }, `Ended with exit code ${encoder.code}; its last lines are below.`) : null,
  ].filter(Boolean));
  $("#ai-encoder-start").disabled = status === "starting" || status === "running";
  // Stop also clears an encoder that failed; one of another command is stopped there.
  $("#ai-encoder-stop").disabled = !own;
  $("#ai-encoder-stop").textContent = status === "failed" ? "Clear" : "Stop encoder";
  lines.hidden = status === "running" || !encoder.lines.length;
  lines.replaceChildren(...encoder.lines.slice(-8).map((line) => h("div", {}, line)));
}

async function aiEncoderCommand(path) {
  $("#ai-encoder-error").textContent = "";
  for (const id of ["#ai-encoder-start", "#ai-encoder-stop"]) $(id).disabled = true;
  try {
    await api(path, { method: "POST", body: "{}" });
  } catch (error) {
    $("#ai-encoder-error").textContent = error.message;
  }
  await aiEncoderRefresh();
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
$("#ai-encoder-start").addEventListener("click", () => aiEncoderCommand("/api/index/encoder/start"));
$("#ai-encoder-stop").addEventListener("click", () => aiEncoderCommand("/api/index/encoder/stop"));
for (const button of document.querySelectorAll("#ai-tabs button")) button.addEventListener("click", () => aiSwitchTab(button.dataset.aitab));
setInterval(() => { if (ixAutoRefresh("ai", "#ai-auto")) aiRefresh(); }, 5000);
// A start takes from seconds to minutes: its state is asked for more often until it answers.
setInterval(() => { if (state.screen === "ai" && document.visibilityState === "visible" && ai.encoder?.status === "starting") aiEncoderRefresh(); }, 1500);
