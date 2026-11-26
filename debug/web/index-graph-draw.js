"use strict";
// Index > Graph: the drawing, its model, layout and highlighting.

// ── The drawing ──
const grUnit = (dx, dy) => { const length = Math.hypot(dx, dy) || 1; return { x: dx / length, y: dy / length }; };
const grOverlaps = (a, b, margin = 2) => a.x < b.x + b.width + margin && a.x + a.width + margin > b.x && a.y < b.y + b.height + margin && a.y + a.height + margin > b.y;

/**
 * What the drawing shows. With a hub (the patient of the facts, or the Patient node of the
 * original graph), everything that starts or ends at it is one spoke per entity, with a line
 * per status; the other statements are relations, one per ends, predicate and status (in the
 * original graph, per ends and predicate).
 */
function grModel() {
  const graph = grGraph(), original = grOriginal();
  const showFacts = $("#gr-facts").checked && grPatient();
  const entities = graph.entities.filter((entity) => original || $("#gr-unresolved").checked || entity.id !== null);
  const hub = showFacts ? "patient" : original ? entities.find((entity) => entity.labels.includes("Patient"))?.key ?? null : null;
  const nodes = new Map();
  if (showFacts) nodes.set("patient", { key: "patient", type: "patient", name: "Patient", sub: "", entity: null });
  for (const entity of entities) {
    nodes.set(entity.key, {
      key: entity.key, entity, name: entity.name,
      type: entity.key === hub ? "patient" : entity.type,
      sub: original ? entity.labels.filter((label) => label !== "Entity").join(", ") : entity.id ?? "no ID",
      unresolved: !original && entity.id === null,
    });
  }
  const spokes = new Map(), relations = new Map();
  for (const statement of grStatements()) {
    if (statement.fact && !showFacts) continue;
    const { from, to } = statement;
    if (!nodes.has(from) || !nodes.has(to)) continue;
    if (hub && from !== to && (from === hub || to === hub)) {
      const other = from === hub ? to : from;
      const spoke = spokes.get(other) ?? { key: `spoke:${other}`, spoke: true, from: hub, to: other, statements: [] };
      spoke.statements.push(statement);
      spokes.set(other, spoke);
      continue;
    }
    const key = original ? `${from}|${statement.predicate}|${to}` : `${from}|${statement.predicate}|${to}|${statement.status}`;
    const relation = relations.get(key) ?? { key, from, to, predicate: statement.predicate, status: statement.status, statements: [] };
    relation.statements.push(statement);
    relations.set(key, relation);
  }
  for (const spoke of spokes.values()) {
    spoke.statuses = GR_STATUSES.filter((status) => spoke.statements.some((statement) => statement.status === status));
    spoke.predicate = [...new Set(spoke.statements.map((statement) => statement.predicate))].join(", ");
  }
  const neighbours = new Map([...nodes.keys()].map((key) => [key, new Set()]));
  const load = new Map([...nodes.keys()].map((key) => [key, 0]));
  for (const edge of [...spokes.values(), ...relations.values()]) {
    neighbours.get(edge.from).add(edge.to);
    neighbours.get(edge.to).add(edge.from);
    load.set(edge.from, load.get(edge.from) + edge.statements.length);
    load.set(edge.to, load.get(edge.to) + edge.statements.length);
  }
  return { hub, nodes, spokes: [...spokes.values()], relations: [...relations.values()], neighbours, load };
}

/** Ring positions by type sector, each sector ordered so that related entities sit close together. */
function grLayout(model, width, height) {
  const cx = width / 2, cy = height / 2;
  const ring = [...model.nodes.values()].filter((node) => node.key !== model.hub);
  const sectors = GR_SECTORS.map(() => []);
  for (const node of [...ring].sort((a, b) => a.name.localeCompare(b.name))) {
    const index = GR_SECTORS.indexOf(node.type);
    sectors[index < 0 ? GR_SECTORS.indexOf("other") : index].push(node);
  }
  const filled = sectors.filter((sector) => sector.length);
  const gap = ring.length > 14 ? 0.7 : 1;
  let step = (2 * Math.PI) / Math.max(ring.length + gap * filled.length, 1);
  // Without a hub (a paper), each group of types gets a side of its own, facing the others:
  // diseases right, chemicals left, genes up. With a hub, or when the sides would be cramped,
  // the sectors follow each other around the ring.
  let blocks = filled, anchors = null;
  if (!model.hub && ring.length > 2) {
    const sides = new Map();
    for (const sector of filled) {
      const side = GR_SIDES[sector[0].type] ?? GR_SIDES.other;
      sides.set(side, [...(sides.get(side) ?? []), ...sector]);
    }
    const order = [...sides.keys()].sort((a, b) => a - b);
    let fitted = step;
    if (order.length > 1) order.forEach((side, index) => {
      const next = order[(index + 1) % order.length];
      const distance = (next - side + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      fitted = Math.min(fitted, distance / ((sides.get(side).length + sides.get(next).length) / 2 + gap));
    });
    if (fitted >= step * 0.6) {
      step = fitted;
      blocks = [...sides.values()];
      anchors = new Map([...sides].map(([side, block]) => [block, side]));
    }
  }
  const slots = (2 * Math.PI) / step;
  const angle = new Map();
  const assign = () => {
    if (anchors) {
      for (const block of blocks) block.forEach((node, index) => angle.set(node.key, anchors.get(block) + (index - (block.length - 1) / 2) * step));
      return;
    }
    let at = 0;
    for (const block of blocks) {
      at += gap / 2;
      block.forEach((node, index) => angle.set(node.key, (at + index + 0.5) * step));
      at += block.length + gap / 2;
    }
    // The first sector, the diseases when there are any, faces right.
    const turn = blocks.length ? (gap / 2 + blocks[0].length / 2) * step : 0;
    for (const [key, value] of angle) angle.set(key, value - turn);
  };
  assign();
  const related = new Map(ring.map((node) => [node.key, []]));
  for (const relation of model.relations) {
    if (relation.from === relation.to) continue;
    related.get(relation.from)?.push(relation.to);
    related.get(relation.to)?.push(relation.from);
  }
  // Barycentre passes: an entity moves towards the mean direction of the entities it relates to.
  for (let pass = 0; pass < 4; pass++) {
    for (const sector of blocks) {
      const centre = sector.reduce((sum, node) => sum + angle.get(node.key), 0) / sector.length;
      const wish = new Map(sector.map((node) => {
        const others = related.get(node.key).filter((key) => angle.has(key));
        if (!others.length) return [node.key, angle.get(node.key)];
        const target = Math.atan2(others.reduce((sum, key) => sum + Math.sin(angle.get(key)), 0), others.reduce((sum, key) => sum + Math.cos(angle.get(key)), 0));
        return [node.key, centre + Math.atan2(Math.sin(target - centre), Math.cos(target - centre))];
      }));
      sector.sort((a, b) => wish.get(a.key) - wish.get(b.key));
    }
    assign();
  }
  // A wide ring for the side labels; roomy for small graphs, never cramped for large ones,
  // which then grow beyond the panel and are scaled to fit.
  const aspect = Math.max(1, Math.min(1.7, (width - 300) / Math.max(height - 120, 1)));
  const perimeter = Math.PI * (3 * (aspect + 1) - Math.sqrt((3 * aspect + 1) * (aspect + 3)));
  let ry = Math.min((slots * 80) / perimeter, (height - 120) / 2, (width - 300) / 2 / aspect);
  ry = Math.max(ry, (slots * 52) / perimeter, 150);
  const rx = ry * aspect;
  // Side labels stack in little height, labels above and below need their width: the warp puts
  // more entities at the sides and fewer at the top and bottom.
  const warp = (a) => a - 0.08 * Math.sin(2 * a);
  const positions = new Map();
  if (model.hub) positions.set(model.hub, { x: cx, y: cy });
  for (const node of ring) {
    const a = warp(angle.get(node.key));
    positions.set(node.key, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), angle: Math.atan2(Math.sin(a), Math.cos(a)) });
  }
  if (!model.hub && ring.length === 1) positions.set(ring[0].key, { x: cx, y: cy });
  return { positions, cx, cy };
}

/** A name in at most two lines of about `width` characters; the rest ends in an ellipsis. */
function grWrap(name, width = 24) {
  const lines = [];
  for (const word of name.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && last < 1 && `${lines[last]} ${word}`.length <= width) lines[last] += ` ${word}`;
    else if (last === 1) lines[1] += ` ${word}`;
    else lines.push(word);
  }
  return lines.map((line) => line.length > width + 2 ? `${line.slice(0, width).trimEnd()}…` : line);
}

/** Places of a label around its node, the outward ones first. */
function grLabelPlaces(p, r, w, h, centre, hub) {
  const places = [];
  // A far place gets a leader line to its node.
  const add = (anchor, x, top, far = false) => places.push({ anchor, x, top, far, box: { x: anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2, y: top, width: w, height: h } });
  if (hub) {
    add("middle", p.x, p.y + r + 7);
    add("middle", p.x, p.y - r - 7 - h);
    return places;
  }
  const u = grUnit(p.x - centre.x, p.y - centre.y);
  const side = u.x >= 0 ? 1 : -1, sideAnchor = side > 0 ? "start" : "end", vertical = u.y >= 0 ? 1 : -1;
  const sideX = p.x + side * (r + 7);
  const outward = vertical > 0 ? p.y + r + 5 : p.y - r - 5 - h;
  if (Math.abs(u.x) >= 0.38) {
    for (const shift of [0, 0.55, -0.55, 1.1, -1.1, 1.65]) add(sideAnchor, sideX, p.y - h / 2 + vertical * shift * h, Math.abs(shift) > 1);
    add("middle", p.x, outward);
  } else {
    // Above or below the node; when the neighbours' labels are in the way, a row further out.
    for (const row of [0, 1, 2]) {
      const top = outward + vertical * row * (h + 3);
      add("middle", p.x, top, row > 0);
      add(side > 0 ? "start" : "end", p.x - side * r * 0.6, top, row > 0);
      add(side > 0 ? "end" : "start", p.x + side * r * 0.6, top, row > 0);
      if (row === 0) add(sideAnchor, sideX, p.y - h / 2);
    }
  }
  add(side > 0 ? "end" : "start", p.x - side * (r + 7), p.y - h / 2);
  return places;
}

function grPersonGlyph(x, y, r) {
  return sv("g", { class: "gr-glyph", "aria-hidden": "true" },
    sv("circle", { cx: x, cy: y - r * 0.24, r: r * 0.27 }),
    sv("path", { d: `M${x - r * 0.52},${y + r * 0.56} C${x - r * 0.52},${y + r * 0.06} ${x + r * 0.52},${y + r * 0.06} ${x + r * 0.52},${y + r * 0.56} Z` }));
}

function grNodeTitle(node, model) {
  const statements = plural(model.load.get(node.key), "statement");
  if (!node.entity) return `The patient: start of every patient fact\n${statements}`;
  return `${node.entity.names.join(" / ")}\n${node.sub}, ${node.type}\n${statements}`;
}

function grSpokeTitle(spoke) {
  const counts = spoke.statuses.map((status) => `${spoke.statements.filter((statement) => statement.status === status).length} ${status}`);
  return `${grName(spoke.from)} → ${grName(spoke.to)}\n${spoke.predicate}${grOriginal() ? `, ${plural(spoke.statements.length, "edge")}` : `: ${counts.join(", ")}`}`;
}

/** Draws the graph: spokes and relations, then the nodes, their labels and the edge labels. */
function grDraw(fit = false) {
  const svg = $("#gr-svg");
  const width = svg.clientWidth, height = svg.clientHeight;
  if (!gr.data || !width || !height) return;
  const model = grModel();
  gr.model = model;
  if (!model.nodes.size) {
    gr.model = null;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.replaceChildren(sv("text", { x: width / 2, y: height / 2, class: "gr-empty" }, "No entities to show"));
    return;
  }
  const { positions, cx, cy } = grLayout(model, width, height);
  const centre = { x: cx, y: cy };
  const radius = new Map([...model.nodes.keys()].map((key) => [key, key === model.hub ? 21 : Math.max(10, Math.min(18, 8.5 + 1.7 * Math.sqrt(model.load.get(key))))]));
  const original = grOriginal();
  const selected = (key) => gr.selected === key;
  const towards = (from, to, by) => { const u = grUnit(to.x - from.x, to.y - from.y); return { x: from.x + u.x * by, y: from.y + u.y * by }; };

  const spokeLayer = sv("g", {}, model.spokes.map((spoke) => {
    const a = positions.get(spoke.from), b = positions.get(spoke.to);
    const u = grUnit(b.x - a.x, b.y - a.y), n = { x: -u.y, y: u.x };
    const ra = radius.get(spoke.from) + 3, rb = radius.get(spoke.to) + 3;
    return sv("g", { class: `gr-link gr-spoke${selected(spoke.key) ? " selected" : ""}`, "data-edge": spoke.key, "data-ends": `${spoke.from} ${spoke.to}`, onclick: () => grSelectEdge(spoke), onmouseenter: () => grFocus(null, spoke), onmouseleave: () => grFocus() },
      sv("title", {}, grSpokeTitle(spoke)),
      spoke.statuses.map((status, index) => {
        const offset = (index - (spoke.statuses.length - 1) / 2) * 3.2;
        return sv("line", { x1: a.x + u.x * ra + n.x * offset, y1: a.y + u.y * ra + n.y * offset, x2: b.x - u.x * rb + n.x * offset, y2: b.y - u.y * rb + n.y * offset, class: `gr-edge s-${status}` });
      }),
      sv("line", { x1: a.x + u.x * ra, y1: a.y + u.y * ra, x2: b.x - u.x * rb, y2: b.y - u.y * rb, class: "gr-hit" }));
  }));

  // Relations bend towards the middle of the ring; between the same two entities they fan out.
  const pairs = new Map();
  for (const relation of model.relations) {
    const pair = [relation.from, relation.to].sort().join("|");
    pairs.set(pair, [...(pairs.get(pair) ?? []), relation]);
  }
  const pills = [];
  const relationLayer = sv("g", {});
  for (const group of pairs.values()) group.forEach((relation, index) => {
    const a = positions.get(relation.from), b = positions.get(relation.to);
    const ra = radius.get(relation.from), rb = radius.get(relation.to);
    let d;
    if (relation.from === relation.to) {
      const u = a.x === cx && a.y === cy ? { x: 0, y: -1 } : grUnit(a.x - cx, a.y - cy), n = { x: -u.y, y: u.x };
      const top = { x: a.x + u.x * (ra + 30 + index * 14), y: a.y + u.y * (ra + 30 + index * 14) };
      const start = { x: a.x + (u.x + n.x) * ra * 0.7, y: a.y + (u.y + n.y) * ra * 0.7 }, end = { x: a.x + (u.x - n.x) * ra * 0.75, y: a.y + (u.y - n.y) * ra * 0.75 };
      d = `M${start.x},${start.y} C${top.x + n.x * 24},${top.y + n.y * 24} ${top.x - n.x * 24},${top.y - n.y * 24} ${end.x},${end.y}`;
    } else {
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const sign = relation.from < relation.to ? 1 : -1;
      const n = grUnit(-(b.y - a.y) * sign, (b.x - a.x) * sign);
      const inward = { x: cx - m.x, y: cy - m.y }, chord = Math.hypot(b.x - a.x, b.y - a.y);
      const pull = model.hub ? 0.24 : 0.18;
      let c = Math.hypot(inward.x, inward.y) > 30 ? { x: m.x + inward.x * pull, y: m.y + inward.y * pull } : { x: m.x + n.x * chord * 0.06, y: m.y + n.y * chord * 0.06 };
      const offset = (index - (group.length - 1) / 2) * 26;
      c = { x: c.x + n.x * offset, y: c.y + n.y * offset };
      const start = towards(a, c, ra + 3), end = towards(b, c, rb + 3);
      d = `M${start.x},${start.y} Q${c.x},${c.y} ${end.x},${end.y}`;
    }
    const count = relation.statements.length;
    const arrow = original || !GR_SYMMETRIC.has(relation.predicate) ? `url(#gr-arrow-${relation.status})` : null;
    const path = sv("path", { d, class: `gr-edge s-${relation.status}`, "marker-end": arrow });
    relationLayer.append(sv("g", { class: `gr-link${selected(relation.key) ? " selected" : ""}`, "data-edge": relation.key, "data-ends": `${relation.from} ${relation.to}`, onclick: () => grSelectEdge(relation), onmouseenter: () => grFocus(null, relation), onmouseleave: () => grFocus() },
      sv("title", {}, `${grName(relation.from)} ${relation.predicate} ${grName(relation.to)} (${relation.status}, ${plural(count, "statement")})`),
      path,
      sv("path", { d, class: "gr-hit" })));
    pills.push({ relation, path, text: count > 1 ? `${relation.predicate} ×${count}` : relation.predicate });
  });

  const nodeLayer = sv("g", {}, [...model.nodes.values()].map((node) => {
    const { x, y } = positions.get(node.key), r = radius.get(node.key);
    const hub = node.key === model.hub;
    const classes = ["gr-node", node.unresolved ? "unresolved" : "", hub ? "hub" : "", selected(node.key) ? "selected" : ""].filter(Boolean).join(" ");
    return sv("g", { class: classes, "data-node": node.key, style: `--node: var(--t-${node.type}, var(--dropped))`, onclick: () => grSelectNode(node.key), onmouseenter: () => grFocus(node.key), onmouseleave: () => grFocus() },
      sv("title", {}, grNodeTitle(node, model)),
      sv("circle", { class: "gr-halo", cx: x, cy: y, r: r + 5 }),
      sv("circle", { class: "gr-core", cx: x, cy: y, r }),
      hub ? grPersonGlyph(x, y, r) : null,
      selected(node.key) ? sv("circle", { class: "gr-ring", cx: x, cy: y, r: r + 8 }) : null);
  }));

  const labels = new Map([...model.nodes.values()].map((node) => {
    const lines = node.key === model.hub ? [node.name] : grWrap(node.name);
    const text = sv("text", { x: 0, y: 0 },
      lines.map((line, index) => sv("tspan", { x: 0, dy: index ? 14 : 0 }, line)),
      node.sub ? sv("tspan", { x: 0, dy: 13, class: `gr-sub${node.unresolved ? " none" : ""}` }, node.sub) : null);
    return [node.key, sv("g", { class: "gr-label", "data-node": node.key }, text)];
  }));
  const labelLayer = sv("g", {}, [...labels.values()]);
  const pillLayer = sv("g", {});
  const scene = sv("g", { class: `gr-scene${gr.enter ? " enter" : ""}` }, spokeLayer, relationLayer, nodeLayer, pillLayer, labelLayer);
  gr.enter = false;
  const markers = GR_STATUSES.map((status) =>
    sv("marker", { id: `gr-arrow-${status}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse", class: `s-${status}` },
      sv("path", { d: "M1,1.5 L9,5 L1,8.5 L3,5 Z", class: "gr-arrow" })));
  svg.replaceChildren(
    sv("defs", {}, sv("pattern", { id: "gr-dots", width: 22, height: 22, patternUnits: "userSpaceOnUse" }, sv("circle", { cx: 1, cy: 1, r: 1, class: "gr-dot" })), markers),
    sv("rect", { class: "gr-grid", x: -20000, y: -20000, width: 40000, height: 40000, fill: "url(#gr-dots)" }),
    scene);

  // Node labels around the ring, each at its first free place; measured, not guessed.
  const occupied = [...model.nodes.keys()].map((key) => {
    const p = positions.get(key), r = radius.get(key) + 3;
    return { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r };
  });
  const order = [...model.nodes.values()].sort((a, b) => Number(b.key === model.hub) - Number(a.key === model.hub) || (positions.get(a.key).angle ?? 0) - (positions.get(b.key).angle ?? 0));
  for (const node of order) {
    const text = labels.get(node.key).firstChild;
    const bounds = text.getBBox();
    const places = grLabelPlaces(positions.get(node.key), radius.get(node.key), bounds.width, bounds.height, centre, node.key === model.hub);
    const place = places.find((candidate) => !occupied.some((other) => grOverlaps(candidate.box, other))) ?? places[0];
    occupied.push(place.box);
    text.setAttribute("text-anchor", place.anchor);
    text.setAttribute("y", place.top - bounds.y);
    for (const tspan of text.children) tspan.setAttribute("x", place.x);
    if (place.far) {
      const p = positions.get(node.key), box = place.box, mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const dx = p.x - mid.x, dy = p.y - mid.y;
      const k = Math.min(dx ? box.width / 2 / Math.abs(dx) : Infinity, dy ? box.height / 2 / Math.abs(dy) : Infinity);
      const end = { x: mid.x + dx * k, y: mid.y + dy * k }, start = towards(p, end, radius.get(node.key) + 3);
      if (Math.hypot(end.x - start.x, end.y - start.y) > 6) labels.get(node.key).prepend(sv("line", { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: "gr-leader" }));
    }
  }

  // Edge labels as pills on their curve, where they hide nothing; the others stay in the tooltip.
  if ($("#gr-labels").checked) {
    pills.sort((a, b) => Number(selected(b.relation.key)) - Number(selected(a.relation.key)) || b.relation.statements.length - a.relation.statements.length);
    for (const { relation, path, text } of pills) {
      const label = sv("text", { x: 0, y: 0 }, text);
      const pill = sv("g", { class: `gr-pill${selected(relation.key) ? " selected" : ""}`, "data-edge": relation.key, "data-ends": `${relation.from} ${relation.to}` }, sv("rect", {}), label);
      pillLayer.append(pill);
      const bounds = label.getBBox();
      const w = bounds.width + 12, h = bounds.height + 4;
      const length = path.getTotalLength();
      let place = null;
      for (const offset of [0, 12, -12]) {
        for (const fraction of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
          const at = path.getPointAtLength(length * fraction), ahead = path.getPointAtLength(Math.min(length, length * fraction + 1));
          const u = grUnit(ahead.x - at.x, ahead.y - at.y);
          const x = at.x - u.y * offset, y = at.y + u.x * offset;
          const box = { x: x - w / 2, y: y - h / 2, width: w, height: h };
          if (!occupied.some((other) => grOverlaps(box, other, 1))) { place = { x, y, box }; break; }
        }
        if (place) break;
      }
      if (!place) { pill.remove(); continue; }
      occupied.push(place.box);
      pill.firstChild.setAttribute("x", place.box.x);
      pill.firstChild.setAttribute("y", place.box.y);
      pill.firstChild.setAttribute("width", w);
      pill.firstChild.setAttribute("height", h);
      pill.firstChild.setAttribute("rx", h / 2);
      label.setAttribute("x", place.x);
      label.setAttribute("y", place.y - bounds.y - bounds.height / 2);
    }
  }

  if (fit || grViewport.auto) grFit();
  else grApplyViewport();
  grFocus();
}

/**
 * Highlights a node with its neighbours and edges, or an edge with its ends, and dims the rest;
 * without either, the selection, if any.
 */
function grFocus(nodeKey = null, edge = null) {
  const model = gr.model, svg = $("#gr-svg");
  if (!model) return;
  if (!nodeKey && !edge && gr.selected) {
    if (model.nodes.has(gr.selected)) nodeKey = gr.selected;
    else edge = [...model.spokes, ...model.relations].find((candidate) => candidate.key === gr.selected) ?? null;
  }
  const nodes = edge ? new Set([edge.from, edge.to]) : nodeKey ? new Set([nodeKey, ...model.neighbours.get(nodeKey)]) : null;
  svg.classList.toggle("focusing", Boolean(nodes));
  for (const element of svg.querySelectorAll("[data-node]")) element.classList.toggle("on", Boolean(nodes?.has(element.dataset.node)));
  for (const element of svg.querySelectorAll("[data-edge]")) {
    const on = edge ? element.dataset.edge === edge.key : Boolean(nodeKey) && element.dataset.ends.split(" ").includes(nodeKey);
    element.classList.toggle("on", on);
  }
}
