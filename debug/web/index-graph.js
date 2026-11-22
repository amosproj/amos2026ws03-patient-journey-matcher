"use strict";
// ── Index › Graph: the normalized patient graph or PubTator3 annotations of a paper (#80) ──
const gr = { meta: null, source: null, data: null, tab: "graph", selected: null, loading: 0 };
const GR_TYPES = ["disease", "chemical", "gene", "variant", "procedure", "finding", "device"];
const GR_STATUSES = ["asserted", "suspected", "negated", "planned", "unknown"];
// No direction, so no arrowhead (SYMMETRIC in matcher/algorithms/graph/src/types.ts).
const GR_SYMMETRIC = new Set(["associated_with", "cotreated_with", "compared_with", "interacts_with"]);
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

// Selection and redraws preserve the viewport in both representations.
const grViewport = { x: 0, y: 0, scale: 1, drag: null, suppressClick: false };
function grApplyViewport() {
  const { x, y, scale } = grViewport;
  $("#gr-svg").setAttribute("viewBox", `${x} ${y} ${1100 / scale} ${760 / scale}`);
}
function grResetViewport() {
  Object.assign(grViewport, { x: 0, y: 0, scale: 1 });
  grApplyViewport();
}
function grZoom(factor, point) {
  const old = grViewport.scale;
  const next = Math.max(0.5, Math.min(8, old * factor));
  const at = point ?? { x: grViewport.x + 550 / old, y: grViewport.y + 380 / old };
  grViewport.x = at.x - (at.x - grViewport.x) * old / next;
  grViewport.y = at.y - (at.y - grViewport.y) * old / next;
  grViewport.scale = next;
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
  const colours = { Patient: "patient", Diagnosis: "disease", Symptom: "disease", Allergy: "disease", Medication: "chemical", Procedure: "procedure", TreatmentPlan: "procedure" };
  return {
    entities: raw.nodes.map((node) => ({ key: node.uuid, id: node.uuid, name: node.name, names: [node.name], type: colours[node.labels?.find((label) => label !== "Entity")] ?? "finding", labels: node.labels ?? [], sources: [node.uuid], resolvedBy: "original", raw: node })),
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
  $("#gr-stats").replaceChildren(h("div", { class: "card muted" }, h("b", {}, "…"), h("span", {}, `Normalizing ${name}`)));
  try {
    const data = await api(`/api/graph/normalize?${query}`);
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
    h("span", {}, dot("fill: var(--panel); stroke: var(--muted)", true), "no ID (kept by name)"),
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
  $("#gr-original-note").hidden = !original;
  $("#graph-controls .gr-note:not(#gr-original-note)").hidden = original;
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
  grDraw();
  grTables();
}

/** Choose a label position on its edge, avoiding nodes and already placed labels. */
function grLabelPosition(pointAt, width, height, occupied) {
  const fractions = [0.5];
  for (let step = 1; step <= 7; step++) fractions.push(0.5 - step * 0.06, 0.5 + step * 0.06);
  // Prefer moving along the edge. Offset only when every position on it is occupied.
  for (const offset of [0, 18, -18, 36, -36, 54, -54]) {
    for (const fraction of fractions) {
      const anchor = pointAt(fraction);
      const before = pointAt(Math.max(0, fraction - 0.01));
      const after = pointAt(Math.min(1, fraction + 0.01));
      const dx = after.x - before.x, dy = after.y - before.y;
      const length = Math.hypot(dx, dy) || 1;
      const x = anchor.x - dy / length * offset, y = anchor.y + dx / length * offset;
      const box = { x: x - width / 2 - 5, y: y - height / 2 - 4, width: width + 10, height: height + 8 };
      if (box.x < 0 || box.y < 0 || box.x + box.width > 1100 || box.y + box.height > 760) continue;
      if (occupied.some((other) => box.x < other.x + other.width && box.x + box.width > other.x && box.y < other.y + other.height && box.y + box.height > other.y)) continue;
      return { x, y, box, anchor, offset };
    }
  }
  return null;
}

/** Entities on an ellipse, grouped by type; the patient in the middle. */
function grDraw() {
  const W = 1100, H = 760, cx = W / 2, cy = H / 2;
  const showUnresolved = $("#gr-unresolved").checked;
  const showFacts = $("#gr-facts").checked && grPatient();
  const entities = grGraph().entities
    .filter((entity) => showUnresolved || entity.id !== null)
    .sort((a, b) => GR_TYPES.indexOf(a.type) - GR_TYPES.indexOf(b.type) || a.name.localeCompare(b.name));
  const position = new Map();
  entities.forEach((entity, index) => {
    const angle = (index / entities.length) * 2 * Math.PI - Math.PI / 2;
    position.set(entity.key, { x: cx + 430 * Math.cos(angle), y: cy + 300 * Math.sin(angle) });
  });
  if (showFacts) position.set("patient", { x: cx, y: cy });
  if (grOriginal()) for (const entity of entities) {
    if (entity.labels.includes("Patient")) position.set(entity.key, { x: cx, y: cy });
  }

  // One edge per ends, predicate and status, with how many statements it stands for.
  const edges = new Map();
  for (const statement of grStatements()) {
    if (statement.fact && !showFacts) continue;
    if (!position.has(statement.from) || !position.has(statement.to)) continue;
    const key = grOriginal() ? `original:${statement.origin.ref}` : `${statement.from}|${statement.predicate}|${statement.to}|${statement.status}`;
    const edge = edges.get(key) ?? { key, from: statement.from, to: statement.to, predicate: statement.predicate, status: statement.status, statements: [] };
    edge.statements.push(statement);
    edges.set(key, edge);
  }
  // Edges between the same two nodes are bent apart.
  const pairs = new Map();
  for (const edge of edges.values()) {
    const pair = [edge.from, edge.to].sort().join("|");
    pairs.set(pair, [...(pairs.get(pair) ?? []), edge]);
  }

  const R = 15;
  const markers = GR_STATUSES.map((status) =>
    sv("marker", { id: `gr-arrow-${status}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", class: `s-${status}` },
      sv("path", { d: "M0,0 L10,5 L0,10 z", class: "gr-arrow" })),
  );
  const edgeNodes = [];
  const edgeLabels = [];
  for (const group of pairs.values()) {
    group.forEach((edge, index) => {
      const a = position.get(edge.from), b = position.get(edge.to);
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      // The same normal for both directions, so A→B and B→A bend to different sides.
      const sign = edge.from < edge.to ? 1 : -1;
      const nx = (-dy / length) * sign, ny = (dx / length) * sign;
      const offset = (index - (group.length - 1) / 2) * 46;
      const c = { x: (a.x + b.x) / 2 + nx * offset, y: (a.y + b.y) / 2 + ny * offset };
      const towards = (from, to, by) => {
        const lx = to.x - from.x, ly = to.y - from.y, l = Math.hypot(lx, ly) || 1;
        return { x: from.x + (lx / l) * by, y: from.y + (ly / l) * by };
      };
      const start = towards(a, c, R + 2), end = towards(b, c, R + 4);
      const d = edge.from === edge.to ? `M${a.x-10},${a.y-12} C${a.x-65},${a.y-80} ${a.x+65},${a.y-80} ${a.x+10},${a.y-12}` : `M${start.x},${start.y} Q${c.x},${c.y} ${end.x},${end.y}`;
      const count = edge.statements.length;
      const title = `${grName(edge.from)} ${edge.predicate} ${grName(edge.to)} · ${edge.status} · ${plural(count, "statement")}`;
      const path = sv("path", { d, class: "gr-hit", onclick: () => grSelectEdge(edge) }, sv("title", {}, title));
      if ($("#gr-labels").checked) {
        const label = sv("text", { x: 0, y: 0, class: "gr-edge-label" }, count > 1 ? `${edge.predicate} ×${count}` : edge.predicate);
        edgeLabels.push({ path, label, selected: gr.selected === edge.key });
      }
      edgeNodes.push(
        sv("g", {},
          path,
          sv("path", { d, class: `gr-edge s-${edge.status}${gr.selected === edge.key ? " selected" : ""}`, "marker-end": !grOriginal() && GR_SYMMETRIC.has(edge.predicate) ? null : `url(#gr-arrow-${edge.status})` }),
        ),
      );
    });
  }

  const nodeOf = (key, entity) => {
    const { x, y } = position.get(key);
    const type = entity ? entity.type : "patient";
    const colour = `var(--t-${type}, var(--muted))`;
    const name = entity ? entity.name : "Patient";
    const short = name.length > 28 ? `${name.slice(0, 27)}…` : name;
    const above = key !== "patient" && y < cy - 1;
    const classes = ["gr-node", entity && entity.id === null ? "unresolved" : "", gr.selected === key ? "selected" : ""].join(" ");
    return sv("g", { class: classes, onclick: () => grSelectNode(key) },
      sv("title", {}, entity ? `${entity.names.join(" / ")}\n${entity.id ?? "no ID"} · ${type}` : "The patient: start of every patient fact"),
      sv("circle", { cx: x, cy: y, r: key === "patient" ? R + 5 : R, style: `--node: ${colour}` }),
      // Labels of the upper half go above the node, where its edges do not arrive.
      sv("text", { x, y: above ? y - R - 20 : y + R + 15 }, short),
      sv("text", { x, y: above ? y - R - 7 : y + R + 28, class: "gr-id" }, entity ? (grOriginal() ? entity.labels.filter((label) => label !== "Entity").join(", ") : entity.id ?? "no ID") : ""),
    );
  };
  const nodes = [...(showFacts ? [nodeOf("patient", null)] : []), ...entities.map((entity) => nodeOf(entity.key, entity))];
  const svg = $("#gr-svg");
  grApplyViewport();
  const labelLayer = sv("g", {}, edgeLabels.map(({ label }) => label));
  svg.replaceChildren(sv("defs", {}, markers), ...edgeNodes, labelLayer, ...nodes);
  // Measure actual SVG text, rather than guessing widths from character counts.
  const occupied = nodes.map((node) => node.getBBox());
  edgeLabels.sort((a, b) => Number(b.selected) - Number(a.selected));
  for (const { path, label } of edgeLabels) {
    const bounds = label.getBBox();
    const length = path.getTotalLength();
    const placed = grLabelPosition((fraction) => path.getPointAtLength(length * fraction), bounds.width, bounds.height, occupied);
    if (!placed) {
      // In very dense areas keep the text in the edge tooltip and click details.
      label.remove();
      continue;
    }
    occupied.push(placed.box);
    label.setAttribute("x", placed.x);
    label.setAttribute("y", placed.y - bounds.y - bounds.height / 2);
    if (placed.offset) labelLayer.insertBefore(sv("line", { x1: placed.anchor.x, y1: placed.anchor.y, x2: placed.x, y2: placed.y, stroke: "var(--muted)", "stroke-width": 0.6, "stroke-opacity": 0.5, "pointer-events": "none" }), label);
  }
  if (!entities.length) svg.append(sv("text", { x: cx, y: cy, "text-anchor": "middle", class: "gr-edge-label" }, "No entities to show"));
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
      statement.cue ? ` · cue “${statement.cue}”` : "",
      ` · ${statement.origin.ref}`),
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
  grDetail(
    h("h3", {}, `${grName(edge.from)} ${edge.predicate} ${grName(edge.to)}`),
    h("p", {}, grOriginal() ? null : grStatusPill(edge.status), " ", plural(statements.length, "statement")),
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

$("#gr-view").addEventListener("change", () => { if (gr.data) { grCloseDetail(); grRender(); } });
$("#gr-source").addEventListener("change", (event) => { grResetViewport(); gr.source = event.target.value; if (gr.source.startsWith("paper:")) $("#gr-view").value = "normalized"; gr.data = null; grLoad(); });
const grSvg = $("#gr-svg");
grSvg.addEventListener("wheel", (event) => {
  const point = grPointerPoint(event);
  if (!point || grViewport.drag) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? grSvg.clientHeight : 1);
  grZoom(Math.exp(-Math.max(-200, Math.min(200, delta)) * 0.002), point);
}, { passive: false });
grSvg.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !event.isPrimary) return;
  const matrix = grSvg.getScreenCTM();
  if (!matrix) return;
  grViewport.suppressClick = false;
  grViewport.drag = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: grViewport.x, y: grViewport.y, inverse: matrix.inverse(), moved: false };
});
grSvg.addEventListener("pointermove", (event) => {
  const drag = grViewport.drag;
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 4) return;
  if (!drag.moved) { grSvg.setPointerCapture(event.pointerId); drag.moved = true; }
  const start = new DOMPoint(drag.clientX, drag.clientY).matrixTransform(drag.inverse);
  const now = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.inverse);
  grViewport.x = drag.x - (now.x - start.x);
  grViewport.y = drag.y - (now.y - start.y);
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
let grTyping = 0;
$("#gr-score").addEventListener("input", () => { clearTimeout(grTyping); grTyping = setTimeout(grLoad, 300); });
for (const id of ["#gr-unresolved", "#gr-facts", "#gr-labels"]) $(id).addEventListener("change", () => { if (gr.data) grDraw(); });
for (const button of document.querySelectorAll("#gr-tabs button")) button.addEventListener("click", () => grSwitchTab(button.dataset.grtab));
