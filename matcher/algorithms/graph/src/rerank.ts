import type { GraphQuery, QueryConcept } from "./query.ts";
import { isProstateCancer, type Terminology } from "./resolve.ts";
import type { Candidate } from "./retrieval.ts";
import type { Values } from "./settings.ts";
import {
  careContext,
  isCancer,
  otherCondition,
  otherDisease,
  otherTreatment,
  paperStages,
  phaseConflict,
  type Stage,
  stageFactor,
} from "./stages.ts";

// MeSH headings of lab and animal research, and the age groups only patient studies get.
const LAB = [
  "mesh:D045744", // Cell Line, Tumor
  "mesh:D002460", // Cell Line
  "mesh:D051379", // Mice
  "mesh:D051381", // Rats
  "mesh:D023041", // Xenograft Model Antitumor Assays
  "mesh:D066298", // In Vitro Techniques
  "mesh:D000818", // Animals
];
const AGES = [
  "mesh:D000328", // Adult
  "mesh:D008875", // Middle Aged
  "mesh:D000368", // Aged
  "mesh:D000369", // Aged, 80 and over
];

// Publication types that the LLM grades of the sample journeys rated better or worse.
const FORMATS: Record<string, number> = {
  "Practice Guideline": 1.2,
  Guideline: 1.2,
  Review: 1.15,
  "Systematic Review": 1.15,
  "Meta-Analysis": 1.15,
  "Randomized Controlled Trial": 1.1,
  "Clinical Trial, Phase III": 1.1,
  "Case Reports": 0.7,
  "Clinical Trial Protocol": 0.7,
  Letter: 0.85,
  Comment: 0.85,
  Editorial: 0.85,
  "Clinical Trial, Phase II": 0.85,
};
const SEX_TAGS: Record<string, string> = {
  male: "mesh:D008297",
  female: "mesh:D005260",
};

/** All IDs the patient's own concepts go by, including his diagnoses and their forms. */
function ownIds(query: GraphQuery): Set<string> {
  return new Set([
    ...query.diagnoses.keys(),
    ...query.concepts.flatMap(({ ids }) => ids),
  ]);
}

/** The factor of a paper's publication types: the lowest below 1, else the highest. */
function formatFactor(types: readonly string[], strength: number): number {
  const factors = types.map((type) => FORMATS[type] ?? 1);
  const low = Math.min(1, ...factors);
  const factor = low < 1 ? low : Math.max(1, ...factors);
  return 1 + strength * (factor - 1);
}

/** A paper whose MeSH check tags name only the other sex than the patient's. */
function otherSexOnly(
  mesh: Readonly<Record<string, number>>,
  sex: string | undefined,
): boolean {
  if (sex === undefined) return false;
  const own = SEX_TAGS[sex];
  const others = Object.entries(SEX_TAGS).filter(([one]) => one !== sex);
  return (
    own !== undefined && !(own in mesh) && others.some(([, tag]) => tag in mesh)
  );
}

/** Lab or animal research: such MeSH headings and no age group of patients. */
function isLabResearch(mesh: Readonly<Record<string, number>>): boolean {
  return LAB.some((id) => id in mesh) && !AGES.some((id) => id in mesh);
}

/** The shortlist in its final order: by score, then more specific title evidence, then the older paper. */
export function rerank(
  query: GraphQuery,
  rows: readonly Candidate[],
  values: Values,
  terms: Terminology,
  diagnosisOnly: boolean,
) {
  return rows
    .map((row) => ({ row, ...rank(query, row, values, terms, diagnosisOnly) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.titleScore - a.titleScore ||
        (a.row.published ?? "9999").localeCompare(b.row.published ?? "9999") ||
        (a.row.document_id < b.row.document_id ? -1 : 1),
    );
}

/** The final score of a candidate, with the terms and the reason to show. */
function rank(
  query: GraphQuery,
  row: Candidate,
  values: Values,
  terms: Terminology,
  diagnosisOnly: boolean,
): {
  score: number;
  titleScore: number;
  matchedTerms: string[];
  explanation: string;
} {
  const contributions: { concept: QueryConcept; part: number }[] = [];
  // PubTator does not annotate procedures. Read the same curated concepts from the title
  // of each candidate, counting the stronger of title and indexed evidence once.
  const titleIds = new Set(terms.findConcepts(row.title).map(({ id }) => id));
  const paperNames = (id: string) =>
    row.diagnoses.includes(id) ||
    id in row.mesh ||
    titleIds.has(id) ||
    row.relations.some(
      ({ predicate, object }) => predicate === "treats" && object === id,
    );
  const conflictingHistology =
    query.histology &&
    paperNames(query.histology.conflicting) &&
    !paperNames(query.histology.observed);
  let titleScore = 0;
  let mainTopic = 0;
  const linked: string[] = [];
  const exact: string[] = [];
  const planned: string[] = [];
  const paperSubtypes = new Set<string>();
  let relation = 0;
  const studied =
    diagnosisOnly &&
    row.relations.find(
      ({ predicate, object }) =>
        predicate === "treats" &&
        query.diagnoses.has(object) &&
        object !== query.histology?.conflicting,
    );
  query.concepts.forEach((concept, index) => {
    if (
      concept.diagnoses &&
      !concept.diagnoses.some((id) => row.diagnoses.includes(id))
    )
      return;
    const inTitle = concept.ids.some((id) => titleIds.has(id));
    const strength = Math.max(
      row.matched[index] ?? 0,
      inTitle ? values.title : 0,
    );
    if (strength <= 0) return;
    const worth = concept.weight * (row.idf[index] ?? 0);
    if (
      (concept.role === "drug" || concept.role === "procedure") &&
      (concept.diagnoses || concept.ids.some((id) => query.treatments.has(id)))
    ) {
      const indications = row.relations.filter(
        (r) => r.predicate === "treats" && concept.ids.includes(r.subject),
      );
      const compatible = indications.filter(({ object }) =>
        concept.diagnoses
          ? concept.diagnoses.includes(object)
          : query.diagnoses.has(object) &&
            object !== query.histology?.conflicting,
      );
      if (indications.length && !compatible.length) return;
      const given = compatible.filter(
        ({ object }) => !concept.plannedFor?.includes(object),
      );
      const choices = given.length ? given : compatible;
      const targets = given.length
        ? concept.documentedTargets?.active
        : concept.documentedTargets?.planned;
      const link =
        choices.find(({ object }) => targets?.includes(object)) ?? choices[0];
      if (link) {
        const paperDiagnosis =
          terms.conceptOf(link.object)?.name ?? link.object;
        const target = targets?.includes(link.object)
          ? terms.conceptOf(link.object)
          : targets
              ?.map((id) => terms.conceptOf(id))
              .find(
                (diagnosis) =>
                  diagnosis?.narrower?.includes(link.object) ||
                  diagnosis?.also?.includes(link.object),
              );
        const pair = `${concept.name} → ${target?.name ?? paperDiagnosis}`;
        if (target?.narrower?.includes(link.object))
          paperSubtypes.add(paperDiagnosis);
        if (!given.length) planned.push(pair);
        else {
          (concept.diagnoses ? exact : linked).push(pair);
          relation += values.relation * worth * (concept.diagnoses ? 2 : 1);
        }
      }
    }
    if (inTitle) titleScore += worth * values.title;
    if (concept.role === "diagnosis") {
      mainTopic = Math.max(mainTopic, strength);
      if (studied && concept.ids.includes(studied.object))
        relation += values.relation * worth * strength;
    }
    contributions.push({
      concept,
      part: worth * strength,
    });
  });
  // The prostate rules are for papers on prostate cancer, whatever else the patient has. A paper
  // on another of his cancers gets the states every cancer has. The phase rule holds for papers on
  // his cancer, or on any of his diagnoses when he has none: his treatment is that of his cancer.
  const prostate =
    query.prostateContext && row.diagnoses.some(isProstateCancer);
  const scope = prostate
    ? "prostate"
    : row.diagnoses.some(isCancer)
      ? "cancer"
      : undefined;
  const phased =
    scope !== undefined || ![...query.diagnoses.keys()].some(isCancer);
  const stages =
    scope === undefined
      ? new Set<Stage>()
      : paperStages(row.title, row.mesh, scope);
  const severity = {
    strong: values.conflictStrong,
    moderate: values.conflictModerate,
    mild: values.conflictMild,
  };
  const stage = stageFactor(
    stages,
    query.stage,
    { fit: values.stageFit, ...severity },
    scope ?? "cancer",
  );
  const care =
    prostate && careContext(query.stage, stages, row.title, row.mesh);
  const phase = phased
    ? phaseConflict(
        row.mesh,
        query.stage,
        prostate ? undefined : new Set(query.diagnoses.keys()),
      )
    : undefined;
  const own = ownIds(query);
  const foreign = otherDisease(row.mesh, own, query.diagnoses.keys());
  const condition =
    !foreign &&
    ![...query.diagnoses.keys()].some(isCancer) &&
    otherCondition(row.mesh, own, new Set(query.diagnoses.keys()), terms);
  const alternative = prostate && otherTreatment(row.mesh, own, query.stage);
  const lab = isLabResearch(row.mesh);
  const otherSex = otherSexOnly(row.mesh, query.sex);
  const topic =
    1 - values.mainTopic + values.mainTopic * Math.min(1, mainTopic);
  const score =
    (contributions.reduce((sum, term) => sum + term.part, 0) + relation) *
    topic *
    stage.factor *
    (care ? values.stageFit : 1) *
    (phase === undefined ? 1 : severity[phase]) *
    (conflictingHistology ? severity.strong : 1) *
    (lab ? values.research : 1) *
    (otherSex ? values.population : 1) *
    (foreign ? values.otherDisease : 1) *
    (condition ? values.otherCondition : 1) *
    (alternative ? values.otherTreatment : 1) *
    formatFactor(row.publication_types ?? [], values.format);

  const telling = contributions
    .filter(({ concept, part }) => part > 0 && concept.role !== "aspect")
    .sort((a, b) => b.part - a.part);
  const names = telling.slice(0, 4).map(({ concept }) => concept.name);
  const reasons = [
    names.length > 0
      ? `Matches ${names.join(", ")}.`
      : "Matches the diagnosis.",
    exact.length
      ? `Matches the documented treatment indication (${exact.join(", ")}).`
      : "",
    linked.length
      ? `PubTator3 links the patient's drug to a diagnosis in this paper (${linked.join(", ")}). Patient indication is undocumented.`
      : "",
    planned.length
      ? `Studies a planned treatment (${planned.join(", ")}).`
      : "",
    paperSubtypes.size
      ? `The paper studies a narrower diagnosis (${[...paperSubtypes].join(", ")}).`
      : "",
    conflictingHistology
      ? "Studies a different histology from the patient's."
      : "",
    studied
      ? `Studies a treatment for ${terms.conceptOf(studied.object)?.name ?? studied.object}.`
      : "",
    stage.fitting.length > 0
      ? `About the patient's disease state (${stage.fitting.join(", ").replaceAll("_", " ")}).`
      : "",
    stage.contradicting.length > 0
      ? `About another disease state (${stage.contradicting.join(", ").replaceAll("_", " ")}).`
      : "",
    care ? `About ${care}.` : "",
    phase === undefined ? "" : "About another phase of care.",
    lab ? "Lab or animal research." : "",
    otherSex ? "About patients of the other sex." : "",
    foreign || condition ? "About another disease." : "",
    alternative ? "About a treatment the patient did not get." : "",
  ];
  return {
    score,
    titleScore,
    matchedTerms: [
      ...new Set(
        contributions
          .filter(({ concept }) => concept.role !== "aspect")
          .map(({ concept }) => concept.name),
      ),
    ].sort(),
    explanation: reasons.filter(Boolean).join(" "),
  };
}
