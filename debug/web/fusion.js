"use strict";
// ── Fusion screen: match_journey with the graph_keyword fusion, and the rank each part gave ───
const fu = { meta: null, result: null, ticket: 0 };
const FU_NAMES = { graph: "Graph", keyword: "Keyword" };
const fuStep = (name) => fu.result?.steps?.find((entry) => entry.step === name)?.data;

async function fuShow() {
  if (fu.meta) return;
  try {
    fu.meta = await api("/api/match/meta");
    $("#fu-journey").replaceChildren(...[...new Set([...fu.meta.journeys, ...fu.meta.graphs])]
      .map((id) => h("option", { value: id }, id === "demo" ? "demo-1 (timeline example)" : id)));
    if (fu.meta.missing) $("#fu-error").textContent = fu.meta.missing;
    else await fuRun();
  } catch (error) {
    $("#fu-error").textContent = error.message;
  }
}

function fuBusy(busy) {
  $(".fusion-main").setAttribute("aria-busy", String(busy));
  $("#fu-run").disabled = busy;
  $("#fu-run").textContent = busy ? "Matching …" : "Match";
}

// A patient with a graph goes as the graph: the graph part reads its relationships, the keyword
// part the journey the server makes from it.
async function fuRun() {
  const id = $("#fu-journey").value;
  if (!id) return;
  const ticket = ++fu.ticket;
  const kind = fu.meta.graphs.includes(id) ? "graph" : "journey";
  $("#fu-error").textContent = "";
  fuBusy(true);
  try {
    const patient = await api(`/api/match/journey?${queryString({ id, kind })}`);
    const request = { [kind]: patient, algorithm: "graph_keyword", limit: 10 };
    const result = await api("/api/match", { method: "POST", body: JSON.stringify({ request, via: "direct" }) });
    if (ticket !== fu.ticket) return;
    fu.result = result;
    fuRender();
  } catch (error) {
    if (ticket === fu.ticket) $("#fu-error").textContent = error.message;
  } finally {
    if (ticket === fu.ticket) fuBusy(false);
  }
}

function fuRender() {
  const result = fu.result, answer = result?.answer, fusion = fuStep("fusion");
  const parts = fusion?.parts || [];
  const ranks = new Map((fusion?.fused || []).map((hit) => [hit.documentId, hit.ranks]));
  const results = answer?.results || [];
  const both = results.filter((hit) => Object.keys(ranks.get(hit.source_id) || {}).length > 1).length;
  $("#fu-stats").replaceChildren(...[
    card("Focus event", answer?.focus_event_id ?? "–", answer ? "" : "muted"),
    ...parts.map((part) => card(`${FU_NAMES[part.name] ?? part.name}: hits fused`, part.failed ? "failed" : part.hits, part.failed ? "bad" : "")),
    answer && card("Results both found", both, both ? "" : "muted"),
    card(answer?.degraded ? "Results (degraded)" : "Results", answer ? results.length : "–", answer?.degraded || result?.error ? "bad" : ""),
    result && card("Took, incl. starting the matcher", `${result.seconds.toFixed(2)} s`, "muted"),
  ].filter(Boolean));
  const notice = answer?.degraded_reason || result?.error?.message || "";
  $("#fu-notice").hidden = !notice;
  $("#fu-notice").textContent = notice;
  const depth = fusion?.depth ?? 30, constant = fusion?.rankConstant ?? 60;
  $("#fu-head").replaceChildren(
    h("th", { class: "num" }, "#"),
    h("th", { title: `Rank fusion: each part adds 1 / (${constant} + the rank it gave) from its best ${depth}; scaled to the best hit` }, "Score"),
    ...parts.map((part) => h("th", { class: "num", title: `The rank ${FU_NAMES[part.name] ?? part.name} gave the document; –: not among its best ${depth}` }, `${FU_NAMES[part.name] ?? part.name} rank`)),
    h("th", {}, "Source"), h("th", {}, "Title"), h("th", {}, "Why it matches"));
  $("#fu-results").replaceChildren(...results.map((hit) => h("tr", {},
    h("td", { class: "num" }, hit.rank),
    h("td", { class: "rank-numbers" }, hit.score == null ? "–" : [h("span", { class: "meter" }, h("i", { style: `width:${100 * hit.score}%` })), ` ${hit.score.toFixed(2)}`]),
    ...parts.map((part) => h("td", { class: "num" }, ranks.get(hit.source_id)?.[part.name] ?? "–")),
    h("td", {}, sourcePill(hit.source)),
    h("td", { class: "title" }, h("a", { href: hit.url, target: "_blank", rel: "noopener" }, hit.title),
      h("div", { class: "muted", style: "font-size:12px" }, [typeLabel(hit.content_type), hit.published_date, hit.source_id].filter(Boolean).join(", "))),
    h("td", { class: "small" }, hit.explanation || "–"))));
}

$("#fu-run").addEventListener("click", fuRun);
$("#fu-journey").addEventListener("change", fuRun);
