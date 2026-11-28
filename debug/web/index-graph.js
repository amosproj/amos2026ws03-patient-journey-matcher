"use strict";
// ── Index › Graph: the normalized patient graph or PubTator3 annotations of a paper (#80) ──
const gr = { meta: null, source: null, data: null, tab: "graph", selected: null, loading: 0, model: null, enter: false };
const GR_TYPES = ["disease", "chemical", "gene", "variant", "procedure", "finding", "device"];
const GR_STATUSES = ["asserted", "suspected", "negated", "planned", "unknown"];
// No direction, so no arrowhead (SYMMETRIC in matcher/algorithms/graph/src/types.ts).
const GR_SYMMETRIC = new Set(["associated_with", "cotreated_with", "compared_with", "interacts_with"]);
// The ring, clockwise from the right: the diseases between their treatments and their findings,
// so that treats and indicates stay short.
const GR_SECTORS = ["disease", "chemical", "procedure", "device", "other", "finding", "variant", "gene"];
const GR_SIDES = { disease: 0, chemical: Math.PI, procedure: Math.PI, device: Math.PI, gene: -Math.PI / 2, variant: -Math.PI / 2, finding: Math.PI / 2, other: Math.PI / 2 };
// Node labels of the original patient graph, as the types of the normalized one.
const GR_ORIGINAL_TYPES = {
  Diagnosis: "disease", Symptom: "disease", Allergy: "disease", Medication: "chemical", Procedure: "procedure", TreatmentPlan: "procedure",
  LabTest: "finding", TumorMarker: "finding", PathologyResult: "finding", ImagingResult: "finding", VitalSigns: "finding",
};
const SVG_NS = "http://www.w3.org/2000/svg";

function sv(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// The visible part of the drawing. It fits the graph until the user zooms or pans, and a
// redraw (selection, a checkbox) keeps it.
const grViewport = { view: null, fit: null, auto: true, size: null, drag: null, suppressClick: false };
function grApplyViewport() {
  const { view } = grViewport;
  if (view) $("#gr-svg").setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
}
function grResetViewport() {
  grViewport.auto = true;
}
/** Fits the drawing into the panel; it never grows beyond its own size, so text keeps its size. */
function grFit() {
  const svg = $("#gr-svg"), scene = svg.querySelector(".gr-scene");
  const width = svg.clientWidth, height = svg.clientHeight;
  if (!scene || !width || !height) return;
  // A wider margin at the bottom, where the hint is.
  const box = scene.getBBox(), side = 28, top = 22, bottom = 44;
  const scale = Math.min(1, (width - 2 * side) / Math.max(box.width, 1), (height - top - bottom) / Math.max(box.height, 1));
  const w = width / scale, h = height / scale;
  grViewport.view = { x: box.x + box.width / 2 - w / 2, y: box.y + box.height / 2 - (height + top - bottom) / 2 / scale, w, h };
  grViewport.fit = { ...grViewport.view };
  grViewport.size = { width, height };
  grViewport.auto = true;
  grApplyViewport();
}
function grZoom(factor, point) {
  const { view, fit } = grViewport;
  if (!view) return;
  const w = Math.max(fit.w / 6, Math.min(fit.w * 3, view.w / factor));
  const k = w / view.w;
  const at = point ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  grViewport.view = { x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k, w, h: view.h * k };
  grViewport.auto = false;
  grApplyViewport();
}
function grPointerPoint(event) {
  const matrix = $("#gr-svg").getScreenCTM();
  return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : null;
}
const grOriginal = () => $("#gr-view").value === "original" && gr.data?.kind === "patient";
const grPatient = () => gr.data?.kind === "patient" && !grOriginal();
const grGraph = () => grOriginal() ? gr.data.originalGraph : gr.data.graph;

// Display adapter only: retain each original UUID and edge, without concept merging.
function grOriginalGraph(raw) {
  return {
    entities: raw.nodes.map((node) => ({ key: node.uuid, id: node.uuid, name: node.name, names: [node.name], type: GR_ORIGINAL_TYPES[node.labels?.find((label) => label !== "Entity")] ?? "other", labels: node.labels ?? [], sources: [node.uuid], resolvedBy: "original", raw: node })),
    facts: [], skipped: [],
    relations: raw.edges.map((edge) => ({ subject: edge.source_node_uuid, object: edge.target_node_uuid, predicate: edge.name, status: "unknown", text: edge.fact, validAt: edge.valid_at, invalidAt: edge.invalid_at, origin: { ref: edge.uuid, type: edge.name }, raw: edge })),
  };
}
const grEntity = (key) => grGraph()?.entities.find((entity) => entity.key === key);
const grName = (key) => (key === "patient" ? "Patient" : grEntity(key)?.name ?? key);
const grStatusPill = (status) => h("span", { class: `pill gr-pill s-${status}` }, status);
const grTypePill = (type) => h("span", { class: "pill gr-pill", style: `--status: var(--t-${type})` }, type);

/** Facts and relations as one list of statements, the facts starting at the patient. */
function grStatements() {
  const graph = grGraph();
  return [
    ...graph.facts.map((fact) => ({ ...fact, from: "patient", to: fact.entity, predicate: fact.kind, fact: true })),
    ...graph.relations.map((relation) => ({ ...relation, from: relation.subject, to: relation.object, fact: false })),
  ];
}

async function grShow() {
  grSwitchTab(gr.tab);
  if (!gr.meta) {
    try {
      gr.meta = await api("/api/graph/meta");
    } catch (error) {
      grError(error.message);
      return;
    }
    $("#gr-source").replaceChildren(
      h("optgroup", { label: "Patient graphs (make graph)" }, gr.meta.patients.map((name) => h("option", { value: `patient:${name}` }, name))),
      h("optgroup", { label: "PubTator3 papers (test fixtures)" }, gr.meta.papers.map((name) => h("option", { value: `paper:${name}` }, `PMID ${name}`))),
    );
    gr.source = $("#gr-source").value;
    grLegends();
  }
  if (gr.meta.missing) grError(gr.meta.missing);
  else if (!gr.data) grLoad();
}

function grError(message) {
  $("#gr-stats").replaceChildren(h("div", { class: "card bad" }, h("b", {}, "Cannot show the graph"), h("span", {}, message)));
  $("#gr-svg").replaceChildren();
}

async function grLoad() {
  if (!gr.source) return;
  const [kind, name] = gr.source.split(":");
  $("#gr-score-field").hidden = kind !== "paper";
  $("#gr-facts-field").hidden = kind !== "patient";
  const query = new URLSearchParams({ kind, name, min_score: kind === "paper" ? $("#gr-score").value : "0" });
  const ticket = ++gr.loading;
  $("#gr-stats").replaceChildren(h("div", { class: "card muted" }, h("b", {}, spinner()), h("span", {}, `Normalizing ${name} …`)));
  try {
    const data = await busyArea($("#graph-view .content"), api(`/api/graph/normalize?${query}`));
    if (ticket !== gr.loading) return;
    gr.data = data;
    gr.data.originalGraph = data.original ? grOriginalGraph(data.original) : null;
  } catch (error) {
    if (ticket === gr.loading) grError(error.message);
    return;
  }
  grCloseDetail();
  grRender();
}

function grSwitchTab(tab) {
  gr.tab = tab;
  history.replaceState(null, "", tab === "graph" ? "#index-graph" : `#index-graph-${tab}`);
  for (const button of document.querySelectorAll("#gr-tabs button")) button.classList.toggle("active", button.dataset.grtab === tab);
  for (const section of document.querySelectorAll(".grtab")) section.classList.toggle("active", section.id === `grtab-${tab}`);
  if (tab === "graph" && gr.data) grDraw();
}

function grLegends() {
  const dot = (style, dashed) => sv("svg", { width: 14, height: 14, "aria-hidden": "true" }, sv("circle", { cx: 7, cy: 7, r: 5.5, style, "stroke-width": 2, "stroke-dasharray": dashed ? "3 2" : null }));
  $("#gr-type-legend").replaceChildren(
    ...GR_TYPES.map((type) => h("span", {}, dot(`fill: var(--t-${type}); stroke: var(--t-${type})`), type)),
    h("span", {}, dot("fill: var(--panel); stroke: var(--muted)", true), "no ID: never matches a paper"),
  );
  $("#gr-status-legend").replaceChildren(
    ...GR_STATUSES.map((status) =>
      h("span", {}, sv("svg", { width: 26, height: 10, "aria-hidden": "true" }, sv("line", { x1: 1, y1: 5, x2: 25, y2: 5, class: `gr-edge s-${status}` })), status),
    ),
  );
}

function grRender() {
  const { before, kind } = gr.data;
  const original = grOriginal();
  const graph = grGraph();
  $("#gr-view").querySelector('[value="original"]').disabled = kind !== "patient";
  $("#gr-unresolved").closest("label").hidden = original;
  $("#gr-facts-field").hidden = original || kind !== "patient";
  for (const id of ["#gr-type-legend", "#gr-status-legend"]) {
    $(id).hidden = original;
    $(id).previousElementSibling.hidden = original;
  }
  $("#gr-svg").setAttribute("aria-label", original ? "Original patient graph" : "Normalized graph");
  const withId = graph.entities.filter((entity) => entity.id !== null).length;
  const card = (value, label) => h("div", { class: "card" }, h("b", {}, value), h("span", {}, label));
  $("#gr-stats").replaceChildren(...[
    kind === "patient"
      ? card(`${before.nodes} / ${before.edges}`, "nodes / edges in graph.json")
      : card(`${before.annotations} / ${before.relations}`, "annotations / relations in the export"),
    original ? card(graph.entities.length, "original nodes (UUIDs)") : card(`${withId} / ${graph.entities.length}`, "entities with a shared ID"),
    kind === "patient" && !original ? card(graph.facts.length, "patient facts") : null,
    card(graph.relations.length, original ? "original edges" : "relations"),
    card(graph.skipped.length, "left out"),
  ].filter(Boolean));
  $("#gr-n-entities").textContent = graph.entities.length;
  $("#gr-n-statements").textContent = graph.facts.length + graph.relations.length;
  $("#gr-n-skipped").textContent = graph.skipped.length;
  gr.enter = true;
  grDraw();
  grTables();
}

function grStatementItem(statement) {
  const when = statement.validAt ? `${statement.validAt}${statement.invalidAt ? ` → ${statement.invalidAt}` : ""}` : null;
  return h("li", {},
    h("div", { class: "head" },
      grOriginal() ? null : grStatusPill(statement.status),
      h("b", {}, `${grName(statement.from)} ${statement.predicate} ${grName(statement.to)}`),
      when ? h("span", { class: "muted mono" }, when) : null,
      statement.score != null ? h("span", { class: "muted mono" }, `score ${statement.score}`) : null,
    ),
    h("div", { class: "muted", style: "font-size:12px" },
      `${statement.origin.type}`,
      statement.cue ? `, cue “${statement.cue}”` : "",
      `, ${statement.origin.ref}`),
    statement.text ? h("q", {}, statement.text) : null,
    grOriginal() ? h("details", {}, h("summary", {}, "Original edge"), h("pre", { style: "white-space:pre-wrap;overflow-wrap:anywhere" }, JSON.stringify(statement.raw, null, 2))) : null,
  );
}

function grDetail(...children) {
  const panel = $("#gr-detail");
  panel.replaceChildren(h("button", { type: "button", class: "close", "aria-label": "Close", onclick: grCloseDetail }, "×"), ...children);
  panel.classList.add("open");
}

function grSelectNode(key) {
  gr.selected = key;
  const statements = grStatements().filter((statement) => statement.from === key || statement.to === key);
  statements.sort((a, b) => (a.validAt ?? "").localeCompare(b.validAt ?? ""));
  if (key === "patient") {
    grDetail(h("h3", {}, "Patient"), h("p", { class: "muted" }, "Not an entity: patient facts start here and are not matched with paper triples one to one."), h("h4", {}, plural(statements.length, "patient fact")), h("ul", { class: "gr-stmts" }, statements.map(grStatementItem)));
  } else {
    const entity = grEntity(key);
    const row = (label, value) => [h("dt", {}, label), h("dd", {}, value)];
    grDetail(
      h("h3", {}, entity.name),
      h("dl", {},
        row(grOriginal() ? "Original UUID" : "ID", entity.id ? h("span", { class: "mono" }, entity.id) : h("span", { class: "muted" }, "none: never matched across graphs")),
        row("Resolved by", entity.resolvedBy ?? "–"),
        row("Type", grTypePill(entity.type)),
        row("Labels", entity.labels.join(", ")),
        row("Written as", h("div", { class: "links" }, entity.names.map((name) => h("span", {}, name)))),
        row("Sources", plural(entity.sources.length, gr.data.kind === "patient" ? "node" : "paper")),
      ),
      grOriginal() ? h("details", { open: true }, h("summary", {}, "Original node"), h("pre", { style: "white-space:pre-wrap;overflow-wrap:anywhere" }, JSON.stringify(entity.raw, null, 2))) : null,
      h("h4", {}, plural(statements.length, "statement")),
      h("ul", { class: "gr-stmts" }, statements.map(grStatementItem)),
    );
  }
  grDraw();
}

function grSelectEdge(edge) {
  gr.selected = edge.key;
  const statements = [...edge.statements].sort((a, b) => (a.validAt ?? "").localeCompare(b.validAt ?? ""));
  const summary = grOriginal() ? []
    : edge.spoke ? edge.statuses.map((status) => h("span", {}, grStatusPill(status), ` ${edge.statements.filter((statement) => statement.status === status).length}`))
    : [grStatusPill(edge.status)];
  grDetail(
    h("h3", {}, edge.spoke ? `${grName(edge.from)} → ${grName(edge.to)}` : `${grName(edge.from)} ${edge.predicate} ${grName(edge.to)}`),
    h("p", { class: "gr-summary" }, ...summary, h("span", { class: "muted" }, edge.spoke ? `${edge.predicate}, ${plural(statements.length, "statement")}` : plural(statements.length, "statement"))),
    h("ul", { class: "gr-stmts" }, statements.map(grStatementItem)),
  );
  grDraw();
}

function grCloseDetail() {
  $("#gr-detail").classList.remove("open");
  if (gr.selected !== null) {
    gr.selected = null;
    if (gr.data) grDraw();
  }
}

function grTable(table, headings, rows) {
  table.replaceChildren(
    h("thead", {}, h("tr", {}, headings.map((heading) => h("th", {}, heading)))),
    h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: headings.length, class: "empty" }, "Nothing"))),
  );
}

function grTables() {
  const graph = grGraph();
  const entities = [...graph.entities].sort((a, b) => (a.id === null) - (b.id === null) || GR_TYPES.indexOf(a.type) - GR_TYPES.indexOf(b.type));
  grTable($("#gr-entities"), ["ID", "Resolved by", "Type", "Name", "Written as", "Labels", "Sources"],
    entities.map((entity) =>
      h("tr", { onclick: () => { grSwitchTab("graph"); grSelectNode(entity.key); } },
        h("td", { class: "id" }, entity.id ?? h("span", { class: "muted" }, "no ID")),
        h("td", { class: "small" }, entity.resolvedBy ?? "–"),
        h("td", {}, grTypePill(entity.type)),
        h("td", {}, entity.name),
        h("td", { class: "small" }, entity.names.join(" / ")),
        h("td", { class: "small" }, entity.labels.join(", ")),
        h("td", { class: "num" }, entity.sources.length),
      ),
    ),
  );
  const statements = grStatements().sort((a, b) => (a.validAt ?? "").localeCompare(b.validAt ?? "") || a.predicate.localeCompare(b.predicate));
  grTable($("#gr-statements"), ["Day", "Subject", "Predicate", "Object", "Status", "Cue", "Source type", "Sentence or score"],
    statements.map((statement) =>
      h("tr", {},
        h("td", { class: "when" }, statement.validAt ?? "–"),
        h("td", {}, grName(statement.from)),
        h("td", { class: "mono" }, statement.predicate),
        h("td", {}, grName(statement.to)),
        h("td", {}, grOriginal() ? "–" : grStatusPill(statement.status)),
        h("td", { class: "small" }, statement.cue ?? ""),
        h("td", { class: "small mono" }, statement.origin.type),
        h("td", { class: "small" }, statement.text ?? (statement.score != null ? `score ${statement.score}` : "")),
      ),
    ),
  );
  grTable($("#gr-skipped"), ["Reference", "Type", "Reason"],
    graph.skipped.map((item) => h("tr", {}, h("td", { class: "id" }, item.ref), h("td", { class: "mono" }, item.type), h("td", {}, item.reason))),
  );
}

$("#gr-view").addEventListener("change", () => { if (gr.data) { grResetViewport(); grCloseDetail(); grRender(); } });
$("#gr-source").addEventListener("change", (event) => { grResetViewport(); gr.source = event.target.value; if (gr.source.startsWith("paper:")) $("#gr-view").value = "normalized"; gr.data = null; grLoad(); });
const grSvg = $("#gr-svg");
grSvg.addEventListener("wheel", (event) => {
  const point = grPointerPoint(event);
  if (!point || grViewport.drag || !grViewport.view) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? grSvg.clientHeight : 1);
  grZoom(Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002), point);
}, { passive: false });
grSvg.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !event.isPrimary || !grViewport.view) return;
  const matrix = grSvg.getScreenCTM();
  if (!matrix) return;
  grViewport.suppressClick = false;
  grViewport.drag = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: grViewport.view.x, y: grViewport.view.y, inverse: matrix.inverse(), moved: false };
});
grSvg.addEventListener("pointermove", (event) => {
  const drag = grViewport.drag;
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 4) return;
  if (!drag.moved) { grSvg.setPointerCapture(event.pointerId); drag.moved = true; }
  const start = new DOMPoint(drag.clientX, drag.clientY).matrixTransform(drag.inverse);
  const now = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
  grViewport.view = { ...grViewport.view, x: drag.x - (now.x - start.x), y: drag.y - (now.y - start.y) };
  grViewport.auto = false;
  grSvg.classList.add("panning");
  grApplyViewport();
});
function grEndPan(event) {
  const drag = grViewport.drag;
  if (!drag || drag.id !== event.pointerId) return;
  grViewport.suppressClick = drag.moved;
  grViewport.drag = null;
  grSvg.classList.remove("panning");
  if (grSvg.hasPointerCapture(event.pointerId)) grSvg.releasePointerCapture(event.pointerId);
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) grSvg.addEventListener(type, grEndPan);
// Dragging a node or edge must not open its details on release.
grSvg.addEventListener("click", (event) => {
  if (grViewport.suppressClick) { event.stopImmediatePropagation(); event.preventDefault(); grViewport.suppressClick = false; }
}, true);
grSvg.addEventListener("dblclick", (event) => { if (!event.target.closest(".gr-node, .gr-link")) grFit(); });
$("#gr-zoom-in").addEventListener("click", () => grZoom(1.3));
$("#gr-zoom-out").addEventListener("click", () => grZoom(1 / 1.3));
$("#gr-fit").addEventListener("click", () => grFit());
// A new panel size: a fitted graph is laid out again; a zoomed one keeps its scale and centre.
new ResizeObserver(() => {
  const width = grSvg.clientWidth, height = grSvg.clientHeight, { view, size } = grViewport;
  if (!width || !height || !gr.data || (size && size.width === width && size.height === height)) return;
  if (grViewport.auto || !view || !size) { grDraw(); return; }
  const scale = size.width / view.w;
  grViewport.view = { x: view.x + view.w / 2 - width / scale / 2, y: view.y + view.h / 2 - height / scale / 2, w: width / scale, h: height / scale };
  grViewport.size = { width, height };
  grApplyViewport();
}).observe(grSvg);
let grTyping = 0;
$("#gr-score").addEventListener("input", () => { clearTimeout(grTyping); grTyping = setTimeout(grLoad, 300); });
for (const id of ["#gr-unresolved", "#gr-facts", "#gr-labels"]) $(id).addEventListener("change", () => { if (gr.data) grDraw(); });
for (const button of document.querySelectorAll("#gr-tabs button")) button.addEventListener("click", () => grSwitchTab(button.dataset.grtab));
