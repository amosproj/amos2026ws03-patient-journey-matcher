"use strict";
// Matcher screen, Graph: the patient query of the graph matcher.
// Graph: the query the matcher built from the patient, in the order the match uses it.
const MESH_QUALIFIERS = { Q000009: "adverse effects", Q000175: "diagnosis", Q000188: "drug therapy", Q000473: "pathology", Q000532: "radiotherapy", Q000601: "surgery", Q000628: "therapy", Q000000981: "diagnostic imaging" };
const GQ_ROLES = { stage: "disease state", aspect: "subheading" };
const GQ_COURSE = { diagnosed: "diagnosis confirmed", localTherapy: "local therapy", systemicTherapy: "drug therapy", plannedTherapy: "treatment planned", diagnosticFocus: "test on the focus day" };

function mtGraphQuery(query) {
  // A concept's own ID names it before the other IDs it goes by (narrower forms, other vocabularies).
  const names = new Map();
  for (const all of [false, true]) for (const concept of query.concepts) for (const id of all ? concept.ids : concept.ids.slice(0, 1)) if (!names.has(id)) names.set(id, concept.name);
  for (const histology of query.histologies ?? []) for (const [id, name] of Object.entries(histology.names ?? {})) if (!names.has(id)) names.set(id, name);
  const nameOf = (id) => names.get(id) ?? id;
  const unique = (ids) => [...new Set(ids.map(nameOf))];
  const chips = (items, cls = "term") => items.length ? h("div", { class: "chips" }, items.map((item) => h("span", { class: cls }, item))) : h("span", { class: "muted" }, "none");
  const row = (label, value, title) => h("div", { class: "term-row" }, h("span", { class: "row-label", title }, label), value);
  const panel = (title, note, ...body) => h("div", { class: "panel" }, h("h3", {}, title, h("small", {}, note)), ...body);
  const pool = mtStep("pool");

  const searched = Object.keys(query.diagnoses || {});
  const groups = query.concepts.filter((concept) => concept.role === "diagnosis")
    .map((concept) => ({ name: concept.name, ids: concept.ids.filter((id) => searched.includes(id)) }))
    .filter((group) => group.ids.length);
  const grouped = new Set(groups.flatMap((group) => group.ids));
  for (const id of searched.filter((one) => !grouped.has(one))) groups.push({ name: nameOf(id), ids: [id] });
  const candidates = panel("Candidates", "only papers whose PubTator3 annotations or MeSH headings name one of these diagnoses",
    h("div", { class: "panel-body" }, groups.length ? groups.map((group) => row(group.name, chips(group.ids, "term mono")))
      : h("div", { class: "muted" }, "No diagnosis could be mapped, so no paper was searched. The evidence below says why.")));

  const idf = pool?.idf || {};
  const rows = query.concepts.map((concept) => {
    const rarity = idf[concept.ids[0]];
    return { concept, rarity, worth: rarity == null ? null : concept.weight * rarity };
  }).sort((a, b) => (b.worth ?? b.concept.weight) - (a.worth ?? a.concept.weight));
  const top = Math.max(0, ...rows.map((one) => one.worth ?? 0)) || 1;
  const conceptCell = ({ ids, name, role, focus, diagnoses, plannedFor }) => {
    // A subheading (aspect) is a heading with a MeSH qualifier: Prostatic Neoplasms/drug therapy.
    const [, descriptor, qualifier] = /^(.*?)(Q\d+)$/.exec(ids[0]) || [];
    const aspect = role === "aspect" && descriptor;
    const label = aspect ? `${nameOf(descriptor)} / ${MESH_QUALIFIERS[qualifier] ?? qualifier}` : name;
    const source = aspect ? name.replace(/ \((?:aspect|adverse effects|diagnosis)\)$/, "") : null;
    const notes = [
      source && source !== nameOf(descriptor) ? `from ${source}` : null,
      diagnoses?.length ? `linked to ${unique(diagnoses).join(", ")}` : null,
      plannedFor?.length ? `planned for ${unique(plannedFor).join(", ")}` : null,
    ].filter(Boolean).join("; ");
    return h("td", {}, focus ? h("b", { title: "From the focus day: counts more" }, "★ ", label) : label,
      notes ? h("div", { class: "small muted" }, notes) : null,
      h("div", { class: "mono muted" }, ids.join(" ")));
  };
  const scores = panel("Score", "each concept a paper has adds its worth once: all of it in the title or as a MeSH major topic, less in other headings or the abstract only",
    h("table", {},
      h("thead", {}, h("tr", {},
        h("th", {}, "Concept"), h("th", {}, "Kind"),
        h("th", { class: "num", title: "The weight of its role, by how certain the statement is; the focus day counts more" }, "Weight"),
        h("th", { class: "num", title: "How rare it is among the candidates (inverse document frequency): 0 when every candidate has it" }, "Rarity"),
        h("th", { title: "Weight × rarity: what it adds to a paper that has it in its title" }, "Worth"))),
      h("tbody", {}, rows.map(({ concept, rarity, worth }) => h("tr", {},
        conceptCell(concept),
        h("td", {}, h("span", { class: "pill plain", title: concept.role === "aspect" ? "A MeSH subheading: papers indexed under the heading with this qualifier" : null }, GQ_ROLES[concept.role] ?? concept.role)),
        h("td", { class: "num" }, concept.weight.toFixed(2)),
        h("td", { class: "num" }, rarity == null ? "–" : rarity.toFixed(2)),
        h("td", { class: "rank-numbers" }, worth == null ? "–" : [h("span", { class: "meter" }, h("i", { style: `width:${(100 * worth) / top}%` })), worth.toFixed(2)]))))));

  const { states = [], ...course } = query.stage || {};
  const situation = panel("Re-rank", `the best${pool ? ` ${fmtCount(pool.reranked)}` : ""} by score: up when a paper is about this situation, down when it is about another state or phase of care, another disease, lab research or the other sex`,
    h("div", { class: "panel-body" },
      row("Disease profiles", chips(query.profiles ?? []), "Rules of these diseases on top of the generic ones, each for the papers on its disease"),
      row("Disease state", chips(states.map((one) => one.replaceAll("_", " ")))),
      row("Course so far", chips(Object.entries(course).filter(([, on]) => on === true).map(([key]) => GQ_COURSE[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()))),
      (query.histologies ?? []).map((one) => row("Histology", h("span", {}, `${nameOf(one.observed)}: papers only on ${nameOf(one.conflicting)} rank lower`))),
      row("Drugs received", chips(unique(Object.keys(query.treatments || {}))), "A paper that links one of them to the patient's diagnosis (PubTator3) gains extra; one that links it only to another disease gains nothing for it")));

  const evidence = [...(query.evidence || [])].sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  const read = panel("Evidence", `what the matcher read from the journey up to ${query.cutoff}, and what it could not map`,
    evidence.length ? h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Statement"), h("th", {}, "Concept"), h("th", {}, "Diagnosis"), h("th", {}, "Status"), h("th", {}, "From"))),
      h("tbody", {}, evidence.map(({ date, detail, concept, diagnosis, status, ref }) => h("tr", {},
        h("td", { class: "when" }, date || "–"),
        h("td", {}, detail || "–"),
        h("td", {}, concept ? nameOf(concept) : "–"),
        h("td", {}, diagnosis ? nameOf(diagnosis) : "–"),
        h("td", {}, status ? h("span", { class: `pill gr-pill s-${status}` }, status) : "–"),
        h("td", { class: "mono muted", title: ref }, ref?.length > 12 ? `${ref.slice(0, 8)}…` : ref || "–")))))
      : h("div", { class: "panel-body muted" }, "Nothing recorded."));

  return [
    h("p", { class: "muted", style: "margin:0" }, `How the graph matcher searched as of ${query.cutoff}: it takes the papers on the patient's diagnoses, scores them by the patient's concepts and re-ranks the best by the patient's situation. Results says why each hit matched.`),
    candidates, scores, situation, read,
  ];
}
