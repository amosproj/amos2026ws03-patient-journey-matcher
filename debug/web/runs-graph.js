// Runs: the citation graph canvas, its force layout and pointer handling.

// ── Graph view ────────────────────────────────────────────────────────────────
const canvas = $("#graph");
const ctx = canvas.getContext("2d");
const NODE_LIMIT = 2500;

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  graph.dpr = window.devicePixelRatio || 1;
  graph.width = rect.width; graph.height = rect.height;
  canvas.width = Math.max(1, rect.width * graph.dpr);
  canvas.height = Math.max(1, rect.height * graph.dpr);
  graph.dirty = true;
}

function visibleNodes() {
  const nodes = [...graph.nodes.values()];
  return nodes.length > NODE_LIMIT ? nodes.slice(0, NODE_LIMIT) : nodes;
}

function simulate() {
  const nodes = visibleNodes();
  const k = graph.alpha;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
      // Seeds push each other apart over any distance, so their citation clusters separate.
      const seeds = a.kind === "seed" && b.kind === "seed";
      if (d2 > 25000 && !seeds) continue;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
      const force = ((seeds ? 3000 : 120) * k) / d2;
      a.vx -= dx * force; a.vy -= dy * force; b.vx += dx * force; b.vy += dy * force;
    }
  }
  for (const [from, to] of graph.edges) {
    const a = graph.nodes.get(from), b = graph.nodes.get(to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = ((distance - 35) * 0.04 * k) / distance;
    a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
  }
  for (const node of nodes) {
    node.vx -= node.x * 0.004 * k; node.vy -= node.y * 0.004 * k;
    node.x += Math.max(-20, Math.min(20, node.vx)); node.y += Math.max(-20, Math.min(20, node.vy));
    node.vx *= 0.55; node.vy *= 0.55;
  }
  graph.alpha *= 0.985;
  graph.dirty = true;
}

function radius(node) { return node.kind === "seed" ? 6 : 3.6; }

function draw() {
  const { width, height, dpr } = graph;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!graph.nodes.size) {
    ctx.fillStyle = cssVar("--muted"); ctx.font = "13px system-ui"; ctx.textAlign = "center";
    ctx.fillText(state.view ? "No documents yet" : "No run selected yet", width / 2, height / 2);
    return;
  }
  ctx.translate(width / 2 + graph.ox, height / 2 + graph.oy);
  ctx.scale(graph.scale, graph.scale);
  const focus = state.selected || graph.hover;
  ctx.lineWidth = 0.7 / graph.scale;
  ctx.strokeStyle = cssVar("--line");
  ctx.beginPath();
  const highlighted = [];
  for (const [from, to] of graph.edges) {
    const a = graph.nodes.get(from), b = graph.nodes.get(to);
    if (!a || !b) continue;
    if (focus && (from === focus || to === focus)) { highlighted.push([a, b]); continue; }
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  if (highlighted.length) {
    ctx.strokeStyle = cssVar("--series"); ctx.lineWidth = 1.6 / graph.scale;
    ctx.beginPath();
    for (const [a, b] of highlighted) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke();
  }
  const colors = { seed: cssVar("--seed"), cited: cssVar("--cited"), dropped: cssVar("--dropped") };
  for (const node of visibleNodes()) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius(node), 0, Math.PI * 2);
    ctx.fillStyle = colors[node.kind] || colors.cited;
    ctx.fill();
    if (node.id === focus) { ctx.lineWidth = 2 / graph.scale; ctx.strokeStyle = cssVar("--text"); ctx.stroke(); }
  }
}

function worldPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const sx = event.clientX - rect.left, sy = event.clientY - rect.top;
  return { sx, sy, x: (sx - graph.width / 2 - graph.ox) / graph.scale, y: (sy - graph.height / 2 - graph.oy) / graph.scale };
}

function nodeAt(point) {
  let best = null, bestDistance = Infinity;
  for (const node of visibleNodes()) {
    const dx = node.x - point.x, dy = node.y - point.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < radius(node) + 4 / graph.scale && distance < bestDistance) { best = node; bestDistance = distance; }
  }
  return best;
}

canvas.addEventListener("mousedown", (event) => {
  const point = worldPoint(event);
  graph.drag = { sx: point.sx, sy: point.sy, ox: graph.ox, oy: graph.oy, moved: false, node: nodeAt(point) };
  canvas.classList.add("dragging");
});
window.addEventListener("mouseup", () => {
  if (graph.drag && !graph.drag.moved) {
    if (graph.drag.node) selectDoc(graph.drag.node.id); else closeDetail();
  }
  graph.drag = null;
  canvas.classList.remove("dragging");
});
canvas.addEventListener("mousemove", (event) => {
  const point = worldPoint(event);
  if (graph.drag) {
    const dx = point.sx - graph.drag.sx, dy = point.sy - graph.drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) graph.drag.moved = true;
    if (graph.drag.moved) { graph.ox = graph.drag.ox + dx; graph.oy = graph.drag.oy + dy; graph.dirty = true; }
    return;
  }
  const node = nodeAt(point);
  const tooltip = $("#tooltip");
  if ((node?.id || null) !== graph.hover) { graph.hover = node?.id || null; graph.dirty = true; }
  if (node) {
    tooltip.replaceChildren(h("b", {}, ORIGIN_LABEL[node.kind]), " ", node.id, h("br"), node.title || "");
    tooltip.style.display = "block";
    tooltip.style.left = `${Math.min(point.sx + 14, graph.width - 300)}px`;
    tooltip.style.top = `${point.sy + 14}px`;
  } else tooltip.style.display = "none";
});
canvas.addEventListener("mouseleave", () => { $("#tooltip").style.display = "none"; graph.hover = null; graph.dirty = true; });
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const point = worldPoint(event);
  const scale = Math.max(0.1, Math.min(8, graph.scale * Math.exp(-event.deltaY * 0.0015)));
  graph.ox = point.sx - graph.width / 2 - point.x * scale;
  graph.oy = point.sy - graph.height / 2 - point.y * scale;
  graph.scale = scale;
  graph.dirty = true;
}, { passive: false });

function frame() {
  if (state.screen === "runs" && state.tab === "graph") {
    if (graph.alpha > 0.01) simulate();
    if (graph.dirty) { draw(); graph.dirty = false; }
    const hidden = graph.nodes.size - visibleNodes().length;
    $("#graph-note").textContent = hidden > 0
      ? `${plural(hidden, "node")} hidden (limit ${NODE_LIMIT})`
      : "Scroll to zoom, drag to pan, click for details";
  }
  requestAnimationFrame(frame);
}
