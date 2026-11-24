"use strict";
// ── Matcher screen: match_journey for a journey, with the steps of the match ───
// The arguments of match_journey besides the journey, until the text box holds others: the
// defaults of the contract, written out so that they can be changed.
const MT_DEFAULTS = { algorithm: "keyword", limit: 10 };
const mt = {
  meta: null, args: null, dates: [], asOf: null, request: null, via: null, result: null,
  model: "qwen", tuning: {}, settings: "", tab: "results", cache: new Map(), sources: new Map(), ticket: 0, loadTicket: 0, timer: 0,
};

// The data of a step of the match shown, e.g. "terms"; undefined through the MCP server.
const mtStep = (name) => mt.result?.steps?.find((entry) => entry.step === name)?.data;
const mtSetting = (name) => mtStep("settings")?.find((setting) => setting.name === name)?.value;

async function mtShow() {
  mtSwitchTab(mt.tab);
  try {
    const first = !mt.meta;
    mt.meta = await api("/api/match/meta");
    if (first) {
      $("#mt-journey").replaceChildren(
        ...[...new Set([...mt.meta.journeys, ...mt.meta.graphs])].map((id) => h("option", { value: id }, id === "demo" ? "demo-1 (timeline example)" : id)),
        h("option", { value: "", disabled: true }, "Edited or opened"));
      await mtLoadJourney(mt.meta.journeys[0]);
    }
  } catch (error) {
    $("#mt-error").textContent = error.message;
  }
  mtRenderSide();
}

function mtRenderSide() {
  const mcp = mt.meta?.mcp;
  $("#mt-mcp-state").textContent = mcp ? `${mcp.url}: ${mcp.running ? "running" : "not running, start it with make start"}` : "";
  const viaMcp = $("#mt-mcp").checked;
  for (const input of document.querySelectorAll("#mt-tuning input")) input.disabled = viaMcp;
  if (!viaMcp && mt.meta?.missing) $("#mt-error").textContent = mt.meta.missing;
}

async function mtLoadJourney(id, asOf) {
  const picker = $("#mt-journey");
  picker.value = id;
  picker.dataset.loaded = "";
  clearTimeout(mt.timer);
  const ticket = ++mt.loadTicket;
  const graph = mt.meta.graphs.includes(id) && (mtAlgorithm() === "graph" || !mt.meta.journeys.includes(id));
  try {
    const patient = await api(`/api/match/journey?${queryString({ id, kind: graph ? "graph" : "journey" })}`);
    if (ticket !== mt.loadTicket || picker.value !== id) return;
    picker.dataset.loaded = id;
    mtSetJourney(asOf ? { ...patient, as_of: asOf } : patient);
  } catch (error) {
    if (ticket === mt.loadTicket && picker.value === id) {
      picker.value = "";
      $("#mt-error").textContent = error.message;
    }
  }
}

// Puts a journey into the arguments and keeps their other fields.
function mtSetJourney(journey) {
  const { journey: _, graph: __, ...others } = mt.args || MT_DEFAULTS; // a request has a journey or a graph
  const input = Array.isArray(journey?.nodes) && Array.isArray(journey?.edges) ? { graph: journey } : { journey };
  $("#mt-json").value = JSON.stringify({ ...input, ...others }, null, 2);
  if (mtParse()) mtRun(true);
}

// Daily events from a graph, matching mcp-server/src/graph.ts, for the timeline and as-of slider.
function mtEvents(args) {
  if (Array.isArray(args?.journey?.events)) return args.journey.events.filter((event) => event && typeof event === "object");
  const graph = args?.graph;
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.edges)) return [];
  const byUuid = new Map(graph.nodes.filter((node) => node?.uuid).map((node) => [node.uuid, node]));
  const days = new Map();
  for (const edge of graph.edges) {
    const date = typeof edge?.valid_at === "string" ? edge.valid_at.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ends = [byUuid.get(edge.source_node_uuid), byUuid.get(edge.target_node_uuid)].filter(Boolean);
    if (ends.some((node) => Array.isArray(node.labels) && node.labels.includes("Provider"))) continue;
    for (const node of ends) {
      if (Array.isArray(node.labels) && node.labels.includes("Patient")) continue;
      const names = days.get(date) ?? new Set();
      if (node.name) names.add(node.name);
      days.set(date, names);
    }
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, names]) => ({
    id: date, type: "facts", label: [...names].sort().join(", "), date,
  }));
}

// Reads the arguments from the text box; the server checks them against the contract.
function mtParse() {
  let args;
  try {
    args = JSON.parse($("#mt-json").value);
  } catch (error) {
    $("#mt-json-error").textContent = `Not JSON: ${error.message}`;
    return false;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    $("#mt-json-error").textContent = "Not a JSON object: the arguments of match_journey look like {\"journey\": {…}, \"limit\": 10}";
    return false;
  }
  $("#mt-json-error").textContent = "";
  mt.args = args;
  mtRenderAlgorithm();
  const events = mtEvents(args);
  mt.dates = [...new Set(events.map((event) => event?.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  // The focus is the latest event up to as_of; without as_of, the latest of all.
  const asOf = args.journey?.as_of ?? args.graph?.as_of;
  mt.asOf = (typeof asOf === "string" ? mt.dates.filter((date) => date <= asOf) : mt.dates).at(-1) ?? null;
  const slider = $("#mt-asof");
  slider.max = Math.max(0, mt.dates.length - 1);
  slider.disabled = mt.dates.length < 2;
  mtShowAsOf();
  return true;
}

function mtShowAsOf() {
  $("#mt-asof").value = Math.max(0, mt.dates.indexOf(mt.asOf));
  const asOf = mt.args?.journey?.as_of ?? mt.args?.graph?.as_of;
  $("#mt-asof-date").textContent = typeof asOf === "string" ? asOf : mt.asOf || "–";
  const ahead = mtEvents(mt.args).filter((event) => mt.asOf && event?.date > mt.asOf).length;
  const where = mt.asOf ? `date ${mt.dates.indexOf(mt.asOf) + 1} of ${mt.dates.length}` : "before the first event";
  $("#mt-asof-note").textContent = mt.dates.length > 1 ? `${typeof asOf === "string" ? "" : "the latest event is the focus · "}${where}${ahead ? ` · ${plural(ahead, "later event")} left out` : ""} · drag, or click an event` : "";
  mtRenderTimeline();
}

// Cuts the journey or graph at `date`: writes it to journey.as_of or graph.as_of.
function mtSetAsOf(date) {
  const field = mt.args?.graph ? "graph" : "journey";
  const target = mt.args?.[field];
  if (!target || !mt.dates.includes(date) || date === target.as_of) return;
  const { as_of: _, ...rest } = target;
  mt.args = { ...mt.args, [field]: { as_of: date, ...rest } };
  $("#mt-json").value = JSON.stringify(mt.args, null, 2);
  mt.asOf = date;
  mtShowAsOf();
  clearTimeout(mt.timer);
  mt.timer = setTimeout(() => mtRun(false), 150);
}

// The arguments as they are, plus other ranking constants, which only this screen takes.
const mtAlgorithm = () => mt.args?.algorithm ?? "keyword";

// The ranking constants are the keyword matcher's: other algorithms go without them.
function mtRequest() {
  return Object.keys(mt.tuning).length && !$("#mt-mcp").checked && mtAlgorithm() === "keyword" ? { ...mt.args, tuning: mt.tuning } : mt.args;
}

// What the match does not say itself: how many documents hold each term, and the titles.
async function mtEnrich(result) {
  const terms = result.steps?.find((entry) => entry.step === "terms")?.data;
  const candidates = result.steps?.find((entry) => entry.step === "candidates")?.data || [];
  const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }).catch(() => null);
  const [found, titles] = await Promise.all([
    terms && terms.focus.length + terms.context.length ? post("/api/index/terms", { terms: [...new Set([...terms.focus, ...terms.context])] }) : null,
    candidates.length ? post("/api/db/titles", { ids: candidates.map((candidate) => candidate.id) }) : null,
  ]);
  result.found = found;
  result.titles = Object.fromEntries((titles?.rows || []).map((row) => [row.id, row]));
}

function mtBusy(busy) {
  $(".match-main").setAttribute("aria-busy", String(busy));
  $("#mt-run").disabled = busy;
  $("#mt-run").textContent = busy ? "Matching …" : "Match";
}

// `fresh`: ask the matcher again, e.g. after its code or the index changed; else an answer
// seen for the same request is shown again, which keeps the as-of slider quick.
async function mtRun(fresh) {
  if (!mt.args) return;
  const via = $("#mt-mcp").checked ? "mcp" : "direct";
  const request = mtRequest();
  // The model of the AI algorithm is no argument of match_journey: the MCP server has its own.
  const technique = via === "direct" && mtAlgorithm() === "ai_summary" ? mt.model : undefined;
  const key = JSON.stringify([via, request, technique]);
  const ticket = ++mt.ticket;
  if (fresh) { mt.cache.clear(); mt.sources.clear(); }
  $("#mt-error").textContent = "";
  // The matcher would answer an out-of-range constant only with a failed search.
  const invalid = via === "direct" && mtAlgorithm() === "keyword" && [...document.querySelectorAll("#mt-tuning input")].find((input) => !input.checkValidity());
  if (invalid) {
    $("#mt-error").textContent = `${invalid.dataset.name} must be ${invalid.step === "1" ? "a whole number" : "a number"} from ${invalid.min} to ${invalid.max}`;
    mtBusy(false);
    return;
  }
  let result = mt.cache.get(key);
  if (!result) {
    mtBusy(true);
    try {
      result = await api("/api/match", { method: "POST", body: JSON.stringify({ request, via, technique }) });
      if (ticket !== mt.ticket) return;
      await mtEnrich(result);
      if (ticket !== mt.ticket) return;
      mt.cache.set(key, result);
    } catch (error) {
      if (ticket === mt.ticket) {
        $("#mt-error").textContent = mt.result ? `${error.message} · showing the previous result` : error.message;
        mtBusy(false);
      }
      return;
    }
  }
  mt.request = request;
  mt.via = via;
  mt.result = result;
  mtRender();
  mtBusy(false);
}

function mtRender() {
  dbCloseDetail();
  mtRenderStats();
  mtRenderTimeline();
  mtRenderTerms();
  mtRenderTuning();
  mtRenderNotice();
  mtRenderResults();
  mtRenderRankings();
  mtRenderRaw();
  mtRenderClient();
  mtRenderPending();
}

// AI needs its index: until then match_journey answers NOT_AVAILABLE for it, which shows here
// with what the approach needs.
const MT_PLANNED = {
  ai_summary: {
    name: "AI approach",
    text: "Start the encoder under Index › AI and build the index there, or run make index-ai.",
    doc: "research/ai-based-matching.md",
  },
};

// The algorithm, and under AI the model it matches with.
function mtRenderAlgorithm() {
  const algorithm = mtAlgorithm(), viaMcp = $("#mt-mcp").checked;
  for (const button of document.querySelectorAll("#mt-algorithm button")) button.classList.toggle("active", button.dataset.value === algorithm);
  $("#mt-model-field").hidden = algorithm !== "ai_summary";
  for (const button of document.querySelectorAll("#mt-model button")) {
    button.classList.toggle("active", !viaMcp && button.dataset.value === mt.model);
    button.disabled = viaMcp;
  }
  $("#mt-model-note").textContent = viaMcp ? "The MCP server uses the model it was started with." : "";
}

function mtRenderPending() {
  const algorithm = mt.request?.algorithm ?? "keyword";
  const planned = mt.result?.error?.code === "NOT_AVAILABLE" ? MT_PLANNED[algorithm] ?? { name: algorithm, text: null, doc: null } : null;
  $(".match-main").classList.toggle("pending", Boolean(planned));
  $("#mt-pending").hidden = !planned;
  if (!planned) return;
  $("#mt-pending").replaceChildren(h("div", { class: "mt-pending-card" },
    h("h3", {}, planned.name, h("span", { class: "pill plain" }, "unavailable")),
    h("p", { class: "muted" }, mt.result.error.message),
    planned.text ? h("p", {}, planned.text) : null,
    planned.doc ? h("small", { class: "muted mono" }, planned.doc) : null));
}

for (const button of document.querySelectorAll("#mt-algorithm button")) button.addEventListener("click", () => {
  const picker = $("#mt-journey");
  if (!mt.args || (!picker.value && !mtParse()) || mtAlgorithm() === button.dataset.value) return;
  clearTimeout(mt.timer);
  const previous = mtAlgorithm(), algorithm = button.dataset.value;
  mt.args = { ...mt.args, algorithm };
  $("#mt-json").value = JSON.stringify(mt.args, null, 2);
  mtRenderAlgorithm();
  const selected = picker.value;
  if (selected && (previous === "graph" || algorithm === "graph")) {
    const id = selected === "demo" && algorithm === "graph" ? mt.meta.graphs[0] ?? selected : selected;
    const asOf = id === picker.dataset.loaded ? (mt.args.graph ?? mt.args.journey)?.as_of : undefined;
    mtLoadJourney(id, asOf);
    return;
  }
  mtRun(false);
});
for (const button of document.querySelectorAll("#mt-model button")) button.addEventListener("click", () => {
  if (!mt.args || mt.model === button.dataset.value) return;
  mt.model = button.dataset.value;
  mtRenderAlgorithm();
  mtRun(false);
});

function mtRenderStats() {
  const box = $("#mt-stats");
  const result = mt.result;
  if (!result) { box.replaceChildren(card("Focus event", "–", "muted"), card("Results", "–", "muted")); return; }
  const answer = result.answer;
  const terms = mtStep("terms"), rankings = mtStep("rankings"), candidates = mtStep("candidates"), query = mtStep("query");
  const dropped = candidates?.filter((candidate) => candidate.score == null).length;
  box.replaceChildren(...[
    card("Focus event", answer?.focus_event_id ?? "–", answer ? "" : "muted"),
    terms && card("Search terms: focus + context", `${terms.focus.length + (terms.generic?.length ?? 0)} + ${terms.context.length}`),
    rankings && card("Candidates: metadata + full text", `${rankings.metadata.length} + ${rankings.fullTexts.length}`),
    candidates && card("Candidates without a medical term, dropped", dropped, dropped ? "" : "muted"),
    query && card("Diagnosis IDs for retrieval", Object.keys(query.diagnoses).length, Object.keys(query.diagnoses).length ? "" : "muted"),
    query && card("Patient concepts: focus + other", `${query.concepts.filter((concept) => concept.focus).length} + ${query.concepts.filter((concept) => !concept.focus).length}`),
    query && card("Disease state", query.stage.states.join(", ").replaceAll("_", " ") || "–", query.stage.states.length ? "" : "muted"),
    mtStep("semantic") && card(`Model: ${mtStep("semantic").repository}`, aiName(mtStep("semantic").model)),
    mtStep("semantic") && card("Encode / search", `${Math.round(mtStep("semantic").encoder_ms)} / ${Math.round(mtStep("semantic").search_ms)} ms`),
    card(answer?.degraded ? "Results (degraded)" : "Results", answer ? answer.results.length : "–", answer?.degraded || result.error ? "bad" : ""),
    card(result.steps?.length ? "Took, incl. starting the matcher" : "Took", `${result.seconds.toFixed(2)} s`, "muted"),
  ].filter(Boolean));
  $("#mt-count").textContent = answer ? answer.results.length : 0;
}

function mtRenderTimeline() {
  const box = $("#mt-timeline");
  const events = mtEvents(mt.args);
  if (!events.length) { box.replaceChildren(h("div", { class: "empty" }, mt.args?.graph ? "The graph has no dated medical facts." : "The journey has no events.")); return; }
  // Focus and context are the matcher's; they show once its answer for this journey is here.
  const current = mt.request?.journey === mt.args?.journey && mt.request?.graph === mt.args?.graph ? mt.result : null;
  const focus = current?.answer?.focus_event_id;
  const context = new Set(current?.steps?.find((entry) => entry.step === "journey")?.data.context || []);
  const date = (event) => String(event.date || "");
  const sorted = [...events].sort((a, b) => date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : 0);
  box.replaceChildren(...sorted.map((event) => {
    const role = mt.asOf && date(event) > mt.asOf ? "future" : event.id === focus ? "focus" : context.has(event.id) ? "context" : "";
    const says = { future: "after the as-of date: left out", focus: "the focus: the event that is matched", context: "context: an older event that still counts" }[role] || "";
    return h("button", { type: "button", class: `ev ${role}`, title: `${event.label || ""}${says ? `\n${says}` : ""}\nClick: cut the journey at ${date(event)}`, onclick: () => mtSetAsOf(date(event)) },
      h("span", { class: "when" }, date(event) || "no date"),
      h("span", { class: "dot" }),
      h("span", { class: "label" }, event.label || ""),
      h("span", { class: "what" }, [role ? { focus: "Focus", context: "Context", future: "Later" }[role] : null, event.id, event.type].filter(Boolean).join(" · ")));
  }));
  const shown = box.querySelector(".ev.focus") || [...box.querySelectorAll(".ev:not(.future)")].at(-1);
  if (shown) box.scrollLeft = Math.max(0, shown.offsetLeft - box.offsetLeft - box.clientWidth / 2 + shown.offsetWidth / 2);
}

function mtRenderTerms() {
  const box = $("#mt-terms");
  const terms = mtStep("terms");
  $("#mt-term-details").hidden = !terms;
  if (!terms) return;
  const found = new Map((mt.result.found?.terms || []).map((term) => [term.term, term]));
  const totals = mt.result.found?.totals;
  const generic = terms.generic || [];
  const [focusEvent, ...older] = terms.events;
  // How many older events name a term: what picks and orders the context terms.
  const named = (term) => older.filter((event) => event.words.some((word) => word.term === term)).length;
  const chip = (term, note) => {
    const count = found.get(term);
    if (!count) return h("span", { class: "term", title: note }, term);
    const nothing = count.stop_words || count.metadata + count.full_text === 0;
    const common = totals && count.metadata > totals.metadata / 2;
    const says = count.stop_words ? "Only English stop words: stored, but not searched, so this term finds nothing."
      : `In ${count.metadata} of ${totals.metadata} metadata texts and ${count.full_text} of ${totals.full_text} full texts.${nothing ? " It finds nothing." : common ? " In more than half of the documents: it hardly tells them apart." : ""}`;
    return h("span", { class: `term${nothing ? " none" : common ? " common" : ""}`, title: [note, says].filter(Boolean).join("\n") }, term,
      h("small", {}, nothing ? "∅" : [common ? "⚠ " : "", h("i", { class: "sq m" }), count.metadata, h("i", { class: "sq f" }), count.full_text]));
  };
  const row = (label, note, title, chips) => h("div", { class: "term-row" },
    h("span", { class: "row-label", title }, label, h("small", {}, note)),
    h("div", { class: "chips" }, chips.length ? chips : h("span", { class: "muted" }, "none")));
  const journey = new Map((mt.args?.journey?.events || []).map((event) => [event?.id, event]));
  const role = (term, isFocus) => terms.focus.includes(term) ? "In the query as a focus term"
    : isFocus && generic.includes(term) ? "In the query once: a generic term"
    : terms.context.includes(term) ? "In the query as a context term"
    : isFocus ? "Not in the query" : `Not in the query: generic, or not among the ${terms.context.length} context terms that the most older events name`;
  // One event: its label, the terms its words became (each once), and the words left out.
  const event = ({ id, words }) => {
    const source = journey.get(id) || {};
    const isFocus = id === focusEvent.id;
    const pairs = new Map(), skipped = new Set(), negated = new Set();
    for (const { word, term, negated: left } of words) {
      if (term == null) (left ? negated : skipped).add(word);
      else pairs.set(`${word}→${term}`, { word, term });
    }
    const termChip = ({ word, term }) => {
      const inQuery = terms.focus.includes(term) || terms.context.includes(term) || (isFocus && generic.includes(term));
      const how = word === term ? "Searched as it is: no translation in german-terms.json" : "Translated by german-terms.json";
      return h("span", { class: `term${inQuery ? "" : " unused"}`, title: `${how}\n${role(term, isFocus)}` }, word, word === term ? null : h("small", {}, `→ ${term}`));
    };
    const left = [
      skipped.size && `Skipped: ${[...skipped].join(" ")}`,
      negated.size && `Negated, left out: ${[...negated].join(" ")}`,
    ].filter(Boolean).join(" · ");
    return h("div", { class: `ev-terms${isFocus ? " focus" : ""}` },
      h("div", { class: "head", title: "Terms come from the label, the text parameters and the names of true flags" },
        h("b", {}, id), [isFocus ? "focus" : "older event", source.date, source.type].filter(Boolean).join(" · ")),
      h("div", {}, source.label || ""),
      h("div", { class: "chips" }, pairs.size ? [...pairs.values()].map(termChip) : h("span", { class: "muted" }, "no search term")),
      left ? h("div", { class: "left", title: "Numbers and the skip list of german-terms.json (function words, units, time spans …) are skipped; so are the words of a negated finding" }, left) : null);
  };
  box.replaceChildren(
    row(`Focus ${focusEvent.id}`, `×${mtSetting("focusWeight") ?? 1} in the query`, "The medical terms of the focus event, repeated this often in the query, so that the sources on the focus rank first.", terms.focus.map((term) => chip(term))),
    row("Context", "older events, ×1", `Up to ${mtSetting("contextTerms") ?? terms.context.length} terms that the most older events name, each once in the query; of two named equally often, the more recent first. Generic terms of older events are left out.`, terms.context.map((term) => chip(term, `Named by ${named(term)} of ${older.length} older events`))),
    row("Generic", "once, never a hit alone", "The generic terms of the focus event (german-terms.json): each once in the query, and a source with only these is no hit.", generic.map((term) => chip(term))),
    h("div", { class: "term-key" }, "Documents with the term", h("i", { class: "sq m" }), "in their metadata", h("i", { class: "sq f" }), "in their full text · ∅ finds nothing · ⚠ in more than half of them"),
    // Stays open from one match to the next, e.g. while the as-of date moves.
    h("details", { open: box.querySelector("details")?.open },
      h("summary", {}, "How each event became search terms"),
      h("div", { class: "ev-terms key" },
        h("div", { class: "head" }, h("b", {}, "Key"), "how to read the rows"),
        h("div", { class: "chips" },
          h("span", { class: "key-item" }, h("span", { class: "term" }, "abirateron", h("small", {}, "→ abiraterone")), "translated"),
          h("span", { class: "key-item" }, h("span", { class: "term" }, "psa"), "searched as it is"),
          h("span", { class: "key-item" }, h("span", { class: "term unused" }, "initial"), "not in the query")),
        h("div", { class: "left" }, "Skipped: numbers, the skip list of german-terms.json, negated findings")),
      [focusEvent, ...older.toReversed()].map(event)));
}

// The matcher's ranking constants as inputs, built again only when their names change.
function mtRenderTuning() {
  const settings = (mt.request?.algorithm ?? "keyword") === "keyword" ? mtStep("settings") : undefined;
  const names = settings ? settings.map((setting) => setting.name).join() : mt.settings;
  $("#mt-tuning-box").hidden = !names || mtAlgorithm() !== "keyword";
  if (!settings || names === mt.settings) return;
  mt.settings = names;
  $("#mt-tuning").replaceChildren(...settings.map((setting) => h("label", { class: "field" },
    h("span", { title: `From ${setting.min} to ${setting.max}${setting.whole ? ", whole numbers" : ""}` }, setting.name, h("small", { class: "muted" }, ` (${setting.default})`)),
    h("input", { type: "number", min: setting.min, max: setting.max, step: setting.whole ? 1 : "any", value: setting.value, "data-name": setting.name, "data-default": setting.default,
      oninput: (event) => {
        const value = event.target.value;
        if (value === "" || Number(value) === setting.default) delete mt.tuning[setting.name];
        else mt.tuning[setting.name] = Number(value);
      },
      onkeydown: (event) => { if (event.key === "Enter") mtRun(true); } }))));
}

function mtRenderNotice() {
  const box = $("#mt-notice");
  const result = mt.result;
  const failure = mtStep("error");
  let text = null, info = false;
  if (result.error) text = `match_journey refuses this request (${result.error.code}):\n${result.error.message}`;
  else if (result.answer.degraded) {
    const missing = /does not exist/.test(failure?.message || "");
    text = `Degraded: ${result.answer.degraded_reason}${failure ? `\n${failure.name || "Error"}${failure.code ? ` ${failure.code}` : ""}: ${failure.message}` : ""}${missing ? "\nThe index is missing: start the indexer on the Index screen, or run make index." : ""}`;
  } else if (!result.answer.results.length) [text, info] = [result.answer.algorithm === "graph" ? "No indexed paper matched a mapped patient diagnosis." : "No stored document shares a term with this journey.", true];
  box.hidden = !text;
  box.className = `notice${info ? " quiet" : ""}`;
  box.textContent = text || "";
}

// The query terms as columns: the focus terms, then the context terms that hit most.
function mtTermColumns(results, candidates) {
  const terms = mtStep("terms");
  const focus = terms ? terms.focus : [];
  const all = terms ? [...focus, ...terms.context.filter((term) => !focus.includes(term))] : [...new Set(results.flatMap((result) => result.matched_terms || []))];
  const hits = (term) => results.filter((result) => (result.matched_terms || []).includes(term)).length;
  const shown = $("#mt-all-terms").checked ? all : all.filter((term) => hits(term) > 0);
  return [
    ...shown.filter((term) => focus.includes(term)).map((term) => ({ term, focus: true })),
    ...shown.filter((term) => !focus.includes(term)).sort((a, b) => hits(b) - hits(a)).map((term) => ({ term, focus: false })),
  ].map((column) => ({ ...column, where: (id) => {
    const candidate = candidates.get(id);
    return candidate ? { metadata: candidate.metadataTerms.includes(column.term), fullText: candidate.fullTextTerms.includes(column.term) } : null;
  } }));
}

const mtBm25 = (score) => score == null ? "–" : score.toFixed(2);

// Where a hit stands among the candidates of each index, rank 1 on the left.
function mtRankStrip(candidate, last) {
  if (!candidate) return [h("td", {}), h("td", {})];
  const at = (rank) => `left:${last > 1 ? (100 * Math.log(rank)) / Math.log(last) : 0}%`;
  const { metadataRank: meta, fullTextRank: full, hasFullText } = candidate;
  // An index counts only where it finds a term: a rank without one adds nothing.
  const metaCounts = meta && candidate.metadataTerms.length > 0;
  const fullCounts = full && candidate.fullTextTerms.length > 0;
  const marks = [];
  if (fullCounts) marks.push(h("i", { class: "f", style: at(full) }));
  if (metaCounts) marks.push(h("i", { class: "m", style: at(meta) }));
  const place = (label, position, counts, bm25) => !position ? `${label}: not among the best ${last}`
    : counts ? `${label}: rank ${position} of the best ${last}, BM25 ${mtBm25(bm25)}` : `${label}: rank ${position}, but none of the terms: adds nothing`;
  const says = [
    place("Metadata", meta, metaCounts, candidate.metadataBm25),
    hasFullText ? place("Full text", full, fullCounts, candidate.fullTextBm25) : "No full text: the metadata rank stands in for it",
  ].join("\n");
  return [
    h("td", { title: says }, h("div", { class: "ranks" }, ...marks)),
    h("td", { class: "rank-numbers", title: says }, `${metaCounts ? meta : "–"} · ${hasFullText ? (fullCounts ? full : "–") : "none"}`),
  ];
}

// What rank fusion adds up for a hit, one part per index; the bar is scaled to the best hit.
function mtFusion(candidate, best) {
  if (candidate?.score == null) return h("td", { class: "muted" }, "–");
  const { metadataScore: meta, fullTextScore: full, hasFullText } = candidate;
  const width = (part) => `width:${best ? (100 * part) / best : 0}%`;
  const says = `Metadata ${meta.toFixed(4)} + full text ${full.toFixed(4)} = ${candidate.score.toFixed(4)}${hasFullText ? "" : "\nNo full text: the metadata rank stands in for it"}`;
  return h("td", { class: "rank-numbers", title: says },
    h("span", { class: "meter split" }, h("i", { class: "m", style: width(meta) }), h("i", { class: "f", style: width(full) })),
    `${meta.toFixed(4)} + ${full.toFixed(4)}`);
}

function mtRenderResults() {
  const head = $("#mt-head"), body = $("#mt-results");
  const results = mt.result?.answer?.results || [];
  const ranked = mtStep("candidates") || [];
  const candidates = new Map(ranked.map((candidate) => [candidate.id, candidate]));
  const columns = mtTermColumns(results, candidates);
  const last = mtSetting("candidates") || 100;
  const constant = mtSetting("rankConstant") ?? 60;
  const fullWeight = mtSetting("fullTextWeight") ?? 1;
  const gap = (index) => index > 0 && columns[index - 1].focus && !columns[index].focus ? h("span", { class: "gap" }) : null;
  // The MCP server answers without the steps: no columns that would stay empty.
  const traced = Boolean(mtStep("candidates"));
  $("#mt-legend").hidden = !traced;
  $("#mt-mcp-note").hidden = mt.via !== "mcp";
  // ticks at 1, 10, 100 … up to the candidates, on mtRankStrip's log scale
  const ticks = [...new Set([...[1, 10, 100, 1000].filter((rank) => rank < last), last])];
  const at = (rank) => (last > 1 ? (100 * Math.log(rank)) / Math.log(last) : 0);
  const axis = h("div", { class: "rank-axis" }, ticks.flatMap((rank, index) => [
    h("i", { style: `left:${at(rank)}%` }),
    h("span", { style: `left:${at(rank)}%;transform:translateX(${index === 0 ? 0 : index === ticks.length - 1 ? -100 : -50}%)` }, rank),
  ]));
  const hasExplanation = results.some((result) => result.explanation);
  head.replaceChildren(...[
    h("th", { class: "num" }, "#"),
    traced
      ? h("th", { title: `What rank fusion adds up for the document, the order of the results: 1 / (${constant} + its rank) from the metadata index and ${fullWeight === 1 ? "1" : fullWeight} / (${constant} + its rank) from the full-text index. An index adds nothing where it finds none of the terms; without a full text, the metadata rank counts for both. The bar is the sum, scaled to the best hit.` },
        "Rank fusion",
        h("small", {}, h("i", { class: "swatch meta" }), "metadata + ", h("i", { class: "swatch full" }), "full text"),
        h("small", {}, fullWeight === 1 ? `each 1 / (${constant} + its rank)` : `1 / (${constant} + rank) + ${fullWeight} / (${constant} + rank)`))
      : h("th", { title: "Relative score in this result list (0 to 1)" }, "Score"),
    h("th", {}, "Source"), h("th", {}, "Title"),
    !traced && hasExplanation && h("th", {}, "Why it matches"),
    traced && h("th", { title: `Where the document stands among the best ${last} candidates of each index, by BM25: rank 1 on the left, on a log scale. Blue: metadata, orange: full text; no dot: not among them, or none of the terms there.` },
      "Rank in each index", h("small", {}, axis)),
    traced && h("th", { title: "The two ranks as numbers. –: not among the candidates, or none of the terms there; none: the document has no full text, so its metadata rank counts for both." },
      "Ranks", h("small", {}, "metadata · full text")),
    h("th", { title: traced ? "The focus terms in bold, then the context terms that most results hold. A cell: left half found in the metadata, right half in the full text. Hover a name for the whole term." : "The terms each result holds (matched_terms). A grey cell: found. Hover a name for the whole term." },
      h("div", { class: "heat-head" }, ...columns.flatMap((column, index) => [gap(index), h("span", { class: column.focus ? "focus" : null, title: column.term }, column.term)]))),
  ].filter(Boolean));
  body.replaceChildren(...results.map((result) => {
    const where = (column) => {
      const found = column.where(result.source_id);
      if (!found) return (result.matched_terms || []).includes(column.term) ? h("span", { title: `${column.term}: found` }, h("i", { class: "any" })) : h("span", { title: `${column.term}: not found` });
      const says = found.metadata && found.fullText ? "in the metadata and the full text" : found.metadata ? "in the metadata" : found.fullText ? "in the full text" : "not found";
      return h("span", { title: `${column.term}: ${says}` }, h("i", { class: found.metadata ? "m" : null }), h("i", { class: found.fullText ? "f" : null }));
    };
    return h("tr", { class: db.selected?.id === result.source_id ? "selected" : null, onclick: () => dbOpenDocument(result.source_id) },
      h("td", { class: "num" }, result.rank),
      traced
        ? mtFusion(candidates.get(result.source_id), ranked[0]?.score)
        : h("td", { class: "rank-numbers" }, result.score == null ? "–" : [h("span", { class: "meter" }, h("i", { style: `width:${100 * result.score}%` })), ` ${result.score.toFixed(2)}`]),
      h("td", {}, sourcePill(result.source)),
      h("td", { class: "title" }, result.title, h("div", { class: "muted", style: "font-size:12px" }, [typeLabel(result.content_type), result.published_date, result.source_id].filter(Boolean).join(" · "))),
      !traced && hasExplanation && h("td", { class: "small" }, result.explanation || "–"),
      traced && mtRankStrip(candidates.get(result.source_id), last),
      h("td", {}, h("div", { class: "heat" }, ...columns.flatMap((column, index) => [gap(index), where(column)]))));
  }));
}

// The two rankings the result is fused from, with the place each candidate ended on.
function mtRenderRankings() {
  const box = $("#mt-rankings");
  const rankings = mtStep("rankings");
  const query = mtStep("query");
  if (!rankings && (mt.request?.algorithm === "graph" || query)) {
    const note = h("p", { class: "muted", style: "grid-column:1 / 3; margin:10px 0 0" },
      "Graph matching weighs the patient's concepts by role, focus and rarity. It uses paper titles, PubTator3 annotations and MeSH headings, then adjusts for disease state and treatment history.");
    if (!query) {
      box.replaceChildren(note, h("div", { class: "empty", style: "grid-column:1 / 3" },
        mt.via === "mcp" ? "The MCP server answers without the steps of the match." : "No graph query trace available."));
      return;
    }
    const section = (label, map) => {
      const entries = Object.entries(map || {});
      return h("div", {},
        h("h3", {}, `${label} (${entries.length})`),
        ...(entries.length
          ? entries.map(([key, weight]) => h("div", { class: "rank-item" }, h("span", { class: "mono" }, key), h("span", { class: "n" }, Number(weight).toFixed(2))))
          : [h("div", { class: "empty" }, "None")]));
    };
    const concepts = Object.fromEntries((query.concepts || []).map((concept) =>
      [`${concept.focus ? "★ " : ""}${concept.name} (${concept.role}) ${concept.ids.join(" ")}`, concept.weight]));
    const { states, ...course } = query.stage || { states: [] };
    const state = Object.fromEntries([
      ...states.map((one) => [one.replaceAll("_", " "), 1]),
      ...Object.entries(course).filter(([, value]) => value).map(([key]) => [key, 1]),
    ]);
    box.replaceChildren(
      note,
      section(`Diagnosis IDs for retrieval (cutoff ${query.cutoff}${query.conceptOnly ? ", timeline only" : ""})`, query.diagnoses),
      section("Concepts by weight, ★ focus", Object.fromEntries(Object.entries(concepts).sort(([, a], [, b]) => b - a))),
      section("Disease state and course", state),
      section("Treatments used for drug–diagnosis links", query.treatments),
    );
    return;
  }
  const intro = h("p", { class: "muted", style: "grid-column:1 / 3; margin:10px 0 0" }, "Before rank fusion: the best candidates of each index in its own order, and where each one ended. Rank fusion merges the two lists into the results.");
  if (!rankings) {
    const why = mt.via === "mcp" ? "The MCP server answers without the steps of the match."
      : mt.result?.error ? "match_journey refused the request, so nothing was ranked."
      : "The match ended before it ranked: the journey has no search terms, or the search failed (see Results).";
    box.replaceChildren(intro, h("div", { class: "empty", style: "grid-column:1 / 3" }, why));
    return;
  }
  const candidates = mtStep("candidates") || [];
  const place = new Map(candidates.map((candidate, index) => [candidate.id, candidate.score == null ? null : index + 1]));
  const results = mt.result.answer?.results.length || 0;
  const titles = mt.result.titles || {};
  const badge = (id) => {
    const final = place.get(id);
    if (final == null) return h("span", { class: "pill none", title: "Dropped: none of the medical terms is in the document" }, "no term");
    return final <= results ? h("span", { class: "pill hit", title: "Its rank in the results" }, `result ${final}`) : h("span", { class: "pill plain", title: "Ranked, but below the limit" }, `place ${final}`);
  };
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const list = (label, cls, ids, bm25) => h("div", {},
    h("h3", {}, h("i", { class: `swatch ${cls}` }), `${label}: its best ${ids.length}, with their BM25 score`),
    ...ids.map((id, index) => h("div", { class: "rank-item", onclick: () => dbOpenDocument(id) },
      h("span", { class: "n" }, index + 1), h("span", {}, badge(id)), h("span", {}, titles[id]?.title || id, " ", h("small", {}, id)),
      h("span", { class: "n", title: "BM25 score in this index: only comparable within the list" }, mtBm25(byId.get(id)?.[bm25])))),
    ids.length ? null : h("div", { class: "empty" }, "No candidates"));
  box.replaceChildren(intro, list("Metadata index", "meta", rankings.metadata, "metadataBm25"), list("Full-text index", "full", rankings.fullTexts, "fullTextBm25"));
}

function mtRenderRaw() {
  const result = mt.result;
  const block = (label, data, open) => h("details", { open }, h("summary", {}, label), h("pre", {}, JSON.stringify(data, null, 2)));
  $("#mt-raw").replaceChildren(
    block(result.error ? "Error" : "Answer of match_journey", result.error || result.answer, true),
    result.steps?.length ? block("Steps of the match", result.steps, false) : null,
    block("Request", mt.request, false));
}

// ── Example client: the answer as an app could show it ────────────────────────
// It reads only what the tools answer, no step of the match and no database row, so it shows
// what a client can build from the contract (Documentation/user/mcp-interface.md).
const CLIENT_FILES = 8;

function mtRenderClient() {
  const box = $("#mt-client");
  const result = mt.result;
  if (result.error) {
    box.replaceChildren(h("div", { class: "notice" }, `The request was refused (${result.error.code}).`));
    return;
  }
  const answer = result.answer;
  const focus = mtEvents(mt.request).find((event) => event?.id === answer.focus_event_id);
  const state = answer.degraded ? h("div", { class: "notice" }, `The search is not available right now, so this is not “nothing relevant”.\n${answer.degraded_reason || ""}`)
    : answer.results.length ? null : h("div", { class: "notice quiet" }, "Nothing relevant for this event.");
  box.replaceChildren(...[
    h("div", { class: "client-head" },
      h("small", {}, [plural(answer.results.length, "source"), focus?.date].filter(Boolean).join(" · ")),
      h("h3", {}, focus?.label || answer.focus_event_id)),
    state, ...answer.results.map(mtClientCard)].filter(Boolean));
}

function mtClientCard(result) {
  const authors = result.authors || [];
  const files = h("div", { class: "files" });
  const long = result.summary && (result.summary.length > 220 || result.summary.includes("\n"));
  const card = h("article", { class: `src-card${result.rank === 1 ? " top-result" : ""}${result.image_url ? " has-image" : ""}` },
    result.image_url ? h("img", { src: result.image_url, alt: "", loading: "lazy" }) : null,
    h("div", {},
      h("div", { class: "src-meta" },
        sourcePill(result.source),
        h("span", {}, [typeLabel(result.content_type), result.published_date].filter(Boolean).join(" · ")),
        h("span", { class: "rank", title: result.score == null ? null : `score ${result.score}: relative to the best source of this list` }, `#${result.rank}`,
          result.score == null ? null : h("span", { class: "meter" }, h("i", { style: `width:${100 * result.score}%` })))),
      h("h4", {}, h("a", { href: result.url, target: "_blank", rel: "noopener noreferrer" }, result.title)),
      authors.length ? h("div", { class: "byline" }, authors.length > 3 ? `${authors.slice(0, 3).join(", ")} and ${authors.length - 3} more` : authors.join(", ")) : null,
      result.explanation ? h("p", { class: "muted", style: "margin:4px 0 0;font-size:13px" }, result.explanation) : null,
      h("p", { class: `summary${result.summary ? "" : " none"}` }, result.summary || "No summary"),
      h("div", { class: "src-foot" },
        h("button", { type: "button", title: "get_source: the files of this source at its origin", onclick: (event) => mtClientFiles(result.source_id, files, event.currentTarget) }, "Files"),
        long ? h("button", { type: "button", onclick: (event) => { event.currentTarget.textContent = card.classList.toggle("more") ? "Less" : "More"; } }, "More") : null,
        h("span", { title: "The client has to follow the licence when it downloads a file" }, result.licence || "Licence unknown")),
      files));
  return card;
}

// Shows the files of a source below its card, or hides them again.
async function mtClientFiles(id, box, button) {
  if (box.childElementCount) { box.replaceChildren(); button.textContent = "Files"; return; }
  const key = `${mt.via}:${id}`;
  button.disabled = true;
  try {
    if (!mt.sources.has(key)) mt.sources.set(key, await api("/api/match/source", { method: "POST", body: JSON.stringify({ source_id: id, via: mt.via }) }));
    box.replaceChildren(...mtClientFileRows(mt.sources.get(key)));
    button.textContent = "Hide files";
  } catch (error) {
    box.replaceChildren(h("div", { class: "error" }, error.message));
  } finally {
    button.disabled = false;
  }
}

function mtClientFileRows(source) {
  if (source.error) return [h("div", { class: "error" }, `get_source refused the request (${source.error.code}): ${source.error.message}`)];
  const { downloads, url } = source.answer;
  const open = { target: "_blank", rel: "noopener noreferrer" };
  // The file name of a link (Zenodo's end in /content after it); the whole link if it has none.
  const name = (link) => {
    try {
      const parts = new URL(link).pathname.split("/").filter(Boolean);
      return decodeURIComponent((parts.at(-1) === "content" ? parts.at(-2) : parts.at(-1)) || link);
    } catch (error) {
      return link;
    }
  };
  return [
    downloads.length ? null : h("div", { class: "muted" }, "No file to download. ", h("a", { href: url, ...open }, "Open the page"), " instead."),
    ...downloads.slice(0, CLIENT_FILES).map((file) => h("div", { class: "file" },
      h("a", { href: file.url, ...open }, name(file.url)),
      h("span", { class: "muted" }, [file.kind, file.media_type, file.size == null ? null : fmtBytes(file.size)].filter(Boolean).join(" · ")))),
    downloads.length > CLIENT_FILES ? h("div", { class: "muted" }, `and ${fmtCount(downloads.length - CLIENT_FILES)} more`) : null,
    h("details", {}, h("summary", {}, `Answer of get_source · ${source.seconds.toFixed(2)} s`), h("pre", {}, JSON.stringify(source.answer, null, 2))),
  ].filter(Boolean);
}

// What this match found of a document, for the top of its panel.
function mtDocumentParts(id) {
  const candidate = (mtStep("candidates") || []).find((entry) => entry.id === id);
  const result = mt.result?.answer?.results.find((entry) => entry.source_id === id);
  if (!candidate && !result) return [];
  const last = mtSetting("candidates") || 100;
  const rows = [["Result", result ? `rank ${result.rank}` : candidate.score == null ? "dropped: none of the medical terms is in it" : "ranked, but below the limit"]];
  if (candidate?.score != null) rows.push(["Rank fusion", `${candidate.metadataScore.toFixed(4)} metadata + ${candidate.fullTextScore.toFixed(4)} full text = ${candidate.score.toFixed(4)}`]);
  if (candidate) rows.push(
    ["Metadata", `${candidate.metadataRank ? `rank ${candidate.metadataRank}, BM25 ${mtBm25(candidate.metadataBm25)}` : `not among the best ${last}`}${candidate.metadataTerms.length ? ` · ${candidate.metadataTerms.join(", ")}` : " · no term"}`],
    ["Full text", !candidate.hasFullText ? "none indexed: the metadata rank stands in for it" : `${candidate.fullTextRank ? `rank ${candidate.fullTextRank}, BM25 ${mtBm25(candidate.fullTextBm25)}` : `not among the best ${last}`}${candidate.fullTextTerms.length ? ` · ${candidate.fullTextTerms.join(", ")}` : " · no term"}`]);
  else if (result.matched_terms?.length) rows.push(["Terms", result.matched_terms.join(", ")]);
  if (result?.explanation) rows.push(["Why it matches", result.explanation]);
  return [h("div", { class: "label" }, "In this match"), h("dl", {}, ...rows.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, value)]))];
}

function mtSwitchTab(tab) {
  mt.tab = tab;
  history.replaceState(null, "", tab === "results" ? "#match" : `#match-${tab}`);
  for (const button of document.querySelectorAll("#mt-tabs button")) button.classList.toggle("active", button.dataset.mttab === tab);
  for (const section of document.querySelectorAll(".mttab")) section.classList.toggle("active", section.id === `mttab-${tab}`);
  dbCloseDetail();
}

for (const button of document.querySelectorAll("#mt-tabs button")) button.addEventListener("click", () => mtSwitchTab(button.dataset.mttab));
$("#mt-run").addEventListener("click", () => mtRun(true));
$("#mt-journey").addEventListener("change", (event) => mtLoadJourney(event.target.value));
$("#mt-open").addEventListener("click", () => $("#mt-file").click());
$("#mt-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  event.target.value = "";
  let journey;
  try {
    journey = JSON.parse(await file.text());
  } catch (error) {
    $("#mt-json-error").textContent = `${file.name} is not JSON: ${error.message}`;
    return;
  }
  $("#mt-journey").value = "";
  mtSetJourney(journey);
});
$("#mt-json").addEventListener("input", () => {
  $("#mt-journey").value = "";
  clearTimeout(mt.timer);
  mt.timer = setTimeout(() => { if (mtParse()) mtRun(true); }, 600);
});
$("#mt-asof").addEventListener("input", (event) => mtSetAsOf(mt.dates[Number(event.target.value)]));
$("#mt-all-terms").addEventListener("change", () => mtRenderResults());
$("#mt-mcp").addEventListener("change", async () => {
  try { mt.meta = await api("/api/match/meta"); } catch (error) { /* shown by the next match */ }
  mtRenderSide();
  mtRenderAlgorithm();
  mtRun(true);
});
$("#mt-tuning-reset").addEventListener("click", () => {
  mt.tuning = {};
  for (const input of document.querySelectorAll("#mt-tuning input")) input.value = input.dataset.default;
  mtRun(true);
});
