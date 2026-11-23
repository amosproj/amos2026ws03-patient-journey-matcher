"use strict";
const ai = { data: null, loading: false };
const aiTechnique = () => $("#ai-technique").value;
const aiName = (model) => model === "qwen" ? "Qwen" : "BGE-M3";

async function aiRefresh() {
  if (ai.loading) return;
  ai.loading = true;
  const technique = aiTechnique();
  try {
    const data = await api(`/api/index?${queryString({ technique })}`);
    if (technique !== aiTechnique()) return;
    ai.data = data;
    if (ix.overview) ix.overview.indexer = data.indexer;
    const running = data.indexer.run?.status === "running";
    $("#ai-start").disabled = running || Boolean(data.indexer.missing);
    $("#ai-stop").disabled = !running;
    $("#ai-technique").disabled = running;
    $("#ai-error").textContent = data.indexer.missing || "";
    const ready = data.models.every((model) => model.ready && !model.pending);
    $("#ai-state").replaceChildren(h("b", {}, ready ? "Up to date" : "Index build needed"),
      ...data.models.map((model) => h("small", {}, `${aiName(model.model)}: ${fmtCount(model.indexed)} embedded, ${fmtCount(model.pending)} pending`)));
    $("#ai-stats").replaceChildren(card("Documents", fmtCount(data.models[0]?.documents ?? 0)),
      ...data.models.flatMap((model) => [
        card(`${aiName(model.model)} embedded`, fmtCount(model.indexed)),
        card(`${aiName(model.model)} pending`, fmtCount(model.pending)),
        card(`${aiName(model.model)} empty metadata`, fmtCount(model.empty)),
        card(`${aiName(model.model)} index`, model.ready ? "Ready" : "Building"),
      ]));
    $("#ai-coverage").replaceChildren(...data.models.map(aiCoveragePanel));
    renderIxButtons();
    renderIxStats();
    await ixFollowRun();
  } catch (error) {
    $("#ai-error").textContent = error.message;
    $("#ai-start").disabled = true;
  } finally {
    ai.loading = false;
  }
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
  ai.data = null;
  $("#ai-stats").replaceChildren();
  $("#ai-coverage").replaceChildren();
  $("#ai-log").replaceChildren();
  ix.run = null;
  while (ai.loading) await new Promise((resolve) => setTimeout(resolve, 50));
  await aiRefresh();
});
$("#ai-refresh").addEventListener("click", () => aiRefresh());
$("#ai-start").addEventListener("click", () => ixCommand("/api/index/run", { technique: aiTechnique() }));
$("#ai-stop").addEventListener("click", () => ixCommand("/api/index/cancel"));
for (const button of document.querySelectorAll("#ai-tabs button")) button.addEventListener("click", () => aiSwitchTab(button.dataset.aitab));
setInterval(() => { if (ixAutoRefresh("ai", "#ai-auto")) aiRefresh(); }, 5000);
