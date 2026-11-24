import type { Hit, Matcher, MatchOptions } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import {
  DEFAULT_WEIGHTS,
  type GraphQuery,
  patientQuery,
  type QueryConcept,
  type QueryWeights,
} from "./query.ts";
import { findConcepts } from "./resolve.ts";
import { MESH_MAJOR, MESH_MINOR } from "./schema.ts";
import {
  careContext,
  otherDisease,
  otherTreatment,
  paperStages,
  phaseConflict,
  stageFactor,
} from "./stages.ts";
import type { Triple } from "./types.ts";

// Ranking constants; `tuning` sets others within min..max (debug UI, benchmark).
const SETTINGS = {
  // How strongly a paper has a concept; the strongest evidence counts.
  title: { value: 1, min: 0, max: 5, whole: false }, // PubTator3 found it in the title
  major: { value: 1, min: 0, max: 5, whole: false }, // a MeSH major topic
  substance: { value: 0.7, min: 0, max: 5, whole: false }, // the chemical list
  minor: { value: 0.5, min: 0, max: 5, whole: false }, // another MeSH heading
  text: { value: 0.4, min: 0, max: 5, whole: false }, // PubTator3, abstract only
  // What a concept is worth for the patient, by its role.
  diagnosis: {
    value: DEFAULT_WEIGHTS.roles.diagnosis,
    min: 0,
    max: 20,
    whole: false,
  },
  stage: { value: DEFAULT_WEIGHTS.roles.stage, min: 0, max: 20, whole: false },
  drug: { value: DEFAULT_WEIGHTS.roles.drug, min: 0, max: 20, whole: false },
  procedure: {
    value: DEFAULT_WEIGHTS.roles.procedure,
    min: 0,
    max: 20,
    whole: false,
  },
  test: { value: DEFAULT_WEIGHTS.roles.test, min: 0, max: 20, whole: false },
  gene: { value: DEFAULT_WEIGHTS.roles.gene, min: 0, max: 20, whole: false },
  finding: {
    value: DEFAULT_WEIGHTS.roles.finding,
    min: 0,
    max: 20,
    whole: false,
  },
  symptom: {
    value: DEFAULT_WEIGHTS.roles.symptom,
    min: 0,
    max: 20,
    whole: false,
  },
  focus: { value: DEFAULT_WEIGHTS.focus, min: 1, max: 20, whole: false },
  broader: { value: DEFAULT_WEIGHTS.broader, min: 0, max: 1, whole: false },
  aspect: { value: DEFAULT_WEIGHTS.aspect, min: 0, max: 5, whole: false },
  // Share of the focus factor for a measurement of the focus day (PSA), which recurs.
  measurement: {
    value: DEFAULT_WEIGHTS.measurement,
    min: 0,
    max: 1,
    whole: false,
  },
  // 1: disease-state cues also from the sentences of the statements, 0: names only.
  sentences: { value: 1, min: 0, max: 1, whole: true },
  // The patient's drug linked to his diagnosis by PubTator3, as a share of the drug's worth.
  relation: { value: 0.5, min: 0, max: 5, whole: false },
  // How much a paper loses when the diagnosis is not its main topic (only in the abstract).
  mainTopic: { value: 0.5, min: 0, max: 1, whole: false },
  // A paper about the patient's disease state, or about a state or phase he is not in; how
  // strongly it contradicts his (stages.ts) picks the factor.
  stageFit: { value: 1.3, min: 1, max: 5, whole: false },
  conflictStrong: { value: 0.15, min: 0, max: 1, whole: false },
  conflictModerate: { value: 0.4, min: 0, max: 1, whole: false },
  conflictMild: { value: 0.7, min: 0, max: 1, whole: false },
  // Lab or animal research without patients (MeSH), which can only be generic for him.
  research: { value: 0.25, min: 0, max: 1, whole: false },
  // A paper only on the other sex (MeSH check tags), e.g. women for prostate cancer.
  population: { value: 0.25, min: 0, max: 1, whole: false },
  // A paper about another cancer (major MeSH topic), or about a treatment option he did not get.
  otherDisease: { value: 0.15, min: 0, max: 1, whole: false },
  otherTreatment: { value: 0.7, min: 0, max: 1, whole: false },
  // How much the publication type counts (guidelines and reviews up, case reports down).
  format: { value: 1, min: 0, max: 3, whole: false },
  // Papers re-ranked after the concept score.
  candidates: { value: 300, min: 1, max: 5000, whole: true },
};
type Setting = keyof typeof SETTINGS;

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

type Candidate = {
  document_id: string;
  matched: Record<string, number>;
  idf: Record<string, number>;
  title: string;
  published: string | null;
  publication_types: string[];
  relations: Triple[];
  mesh: Record<string, number>;
};

function settings(
  tuning: MatchOptions["tuning"] = {},
  trace: MatchOptions["trace"],
): Record<Setting, number> {
  const names = Object.keys(SETTINGS) as Setting[];
  const values = Object.fromEntries(
    names.map((name) => [name, tuning[name] ?? SETTINGS[name].value]),
  ) as Record<Setting, number>;
  trace?.(
    "settings",
    names.map((name) => ({
      name,
      ...SETTINGS[name],
      default: SETTINGS[name].value,
      value: values[name],
    })),
  );
  for (const name of names) {
    const { min, max, whole } = SETTINGS[name];
    const value = values[name];
    if (
      !(value >= min && value <= max && (!whole || Number.isInteger(value)))
    ) {
      throw new RangeError(
        `${name} must be a ${whole ? "whole " : ""}number from ${min} to ${max}, not ${value}`,
      );
    }
  }
  return values;
}

function queryWeights(values: Record<Setting, number>): QueryWeights {
  const { roles } = DEFAULT_WEIGHTS;
  return {
    roles: Object.fromEntries(
      Object.keys(roles).map((role) => [
        role,
        role in values
          ? values[role as Setting]
          : roles[role as keyof typeof roles],
      ]),
    ) as QueryWeights["roles"],
    focus: values.focus,
    broader: values.broader,
    aspect: values.aspect,
    sentences: values.sentences === 1,
    measurement: values.measurement,
  };
}

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

/** The patient's drugs that PubTator3 links to one of his diagnoses in the paper. */
function linkedDrugs(
  query: GraphQuery,
  relations: readonly Triple[],
): Set<string> {
  const drugs = new Set<string>();
  for (const { subject, predicate, object } of relations) {
    if (
      predicate === "treats" &&
      query.treatments.has(subject) &&
      query.diagnoses.has(object)
    )
      drugs.add(subject);
  }
  return drugs;
}

export function createGraphMatcher(db: Queryable): Matcher {
  return {
    async match(state, { contentTypes, limit, tuning, trace }) {
      const values = settings(tuning, trace);
      const query = patientQuery(state, queryWeights(values));
      trace?.("query", {
        cutoff: query.cutoff,
        focusDate: state.focus.date,
        conceptOnly: query.conceptOnly,
        diagnoses: Object.fromEntries(query.diagnoses),
        concepts: query.concepts,
        stage: { ...query.stage, states: [...query.stage.states] },
        treatments: Object.fromEntries(query.treatments),
        relations: Object.fromEntries(query.relations),
      });
      if (!query.diagnoses.size) return [];
      // One group per concept: its IDs count once, with the strongest evidence.
      const groups = query.concepts.flatMap((concept, index) =>
        concept.ids.map((id) => ({ index, id, weight: concept.weight })),
      );
      const { rows } = await db.query<Candidate>(
        `WITH q AS (
           SELECT * FROM unnest($1::int[], $2::text[], $3::float8[]) AS q(grp, id, weight)
         ),
         candidates AS MATERIALIZED (
           SELECT g.document_id, g.entities, coalesce(g.mesh, '{}'::jsonb) AS mesh
           FROM graph.documents g
           JOIN public.documents d ON d.id = g.document_id
           WHERE (g.entities ?| $4::text[] OR g.mesh ?| $4::text[])
             AND (d.expires_at IS NULL OR d.expires_at > now())
             AND ($5::text[] IS NULL OR d.content_type = ANY ($5::text[]))
         ),
         evidence AS (
           SELECT c.document_id, q.grp, max(q.weight) AS weight,
                  max(greatest(
                    CASE WHEN c.entities ? q.id THEN
                      CASE WHEN (c.entities -> q.id ->> 'inTitle')::boolean THEN $6::float8 ELSE $7::float8 END
                    ELSE 0 END,
                    CASE WHEN c.mesh ? q.id THEN
                      CASE WHEN ((c.mesh ->> q.id)::int & ${MESH_MAJOR}) <> 0 THEN $8::float8
                           WHEN ((c.mesh ->> q.id)::int & ${MESH_MINOR}) <> 0 THEN $9::float8
                           ELSE $10::float8 END
                    ELSE 0 END)) AS strength
           FROM candidates c JOIN q ON c.entities ? q.id OR c.mesh ? q.id
           GROUP BY c.document_id, q.grp
         ),
         -- Rare among the papers on the diagnosis means telling: inverse frequency as in BM25.
         idf AS (
           SELECT grp, ln(1 + ((SELECT count(*) FROM candidates) - count(*) + 0.5) / (count(*) + 0.5)) AS idf
           FROM evidence GROUP BY grp
         ),
         scored AS (
           SELECT e.document_id, sum(e.weight * e.strength * i.idf) AS score,
                  jsonb_object_agg(e.grp, e.strength) AS matched
           FROM evidence e JOIN idf i USING (grp)
           GROUP BY e.document_id
         )
         SELECT s.document_id, s.matched,
                (SELECT jsonb_object_agg(grp, idf) FROM idf) AS idf,
                d.title, d.published_at::text AS published, d.publication_types,
                g.relations, coalesce(g.mesh, '{}'::jsonb) AS mesh
         FROM scored s
         JOIN graph.documents g ON g.document_id = s.document_id
         JOIN public.documents d ON d.id = s.document_id
         ORDER BY s.score DESC, d.published_at NULLS LAST, s.document_id
         LIMIT $11`,
        [
          groups.map(({ index }) => index),
          groups.map(({ id }) => id),
          groups.map(({ weight }) => weight),
          [...query.diagnoses.keys()],
          contentTypes ?? null,
          values.title,
          values.text,
          values.major,
          values.minor,
          values.substance,
          values.candidates,
        ],
      );
      // Not "candidates": the debug UI reads that step as keyword's list.
      trace?.("pool", {
        reranked: rows.length,
        idf: Object.fromEntries(
          query.concepts.map((concept, index) => [
            concept.ids[0],
            rows[0]?.idf[index] ?? 0,
          ]),
        ),
      });
      const hits = rows
        .map((row) => ({ row, ...rank(query, row, values) }))
        // On a tie prefer more specific title evidence, then the older paper.
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.titleScore - a.titleScore ||
            (a.row.published ?? "9999").localeCompare(
              b.row.published ?? "9999",
            ) ||
            (a.row.document_id < b.row.document_id ? -1 : 1),
        )
        .slice(0, limit);
      const best = hits[0]?.score ?? 0;
      return hits
        .filter(({ score }) => score > 0)
        .map(({ row, score, matchedTerms, explanation }) => ({
          documentId: row.document_id,
          score: score / best,
          matchedTerms,
          explanation,
        })) satisfies Hit[];
    },
  };
}

/** The final score of a candidate, with the terms and the reason to show. */
function rank(
  query: GraphQuery,
  row: Candidate,
  values: Record<Setting, number>,
): {
  score: number;
  titleScore: number;
  matchedTerms: string[];
  explanation: string;
} {
  const contributions: { concept: QueryConcept; part: number }[] = [];
  // PubTator does not annotate procedures. Read the same curated concepts from the title
  // of each candidate, counting the stronger of title and indexed evidence once.
  const titleIds = new Set(findConcepts(row.title).map(({ id }) => id));
  let titleScore = 0;
  let mainTopic = 0;
  query.concepts.forEach((concept, index) => {
    const inTitle = concept.ids.some((id) => titleIds.has(id));
    const strength = Math.max(
      row.matched[index] ?? 0,
      inTitle ? values.title : 0,
    );
    if (inTitle)
      titleScore += concept.weight * values.title * (row.idf[index] ?? 0);
    if (strength <= 0) return;
    if (concept.role === "diagnosis") mainTopic = Math.max(mainTopic, strength);
    contributions.push({
      concept,
      part: concept.weight * strength * (row.idf[index] ?? 0),
    });
  });
  const drugs = linkedDrugs(query, row.relations);
  let relation = 0;
  query.concepts.forEach((concept, index) => {
    if (concept.role === "drug" && concept.ids.some((id) => drugs.has(id)))
      relation += values.relation * concept.weight * (row.idf[index] ?? 0);
  });
  const stages = paperStages(row.title, row.mesh);
  const severity = {
    strong: values.conflictStrong,
    moderate: values.conflictModerate,
    mild: values.conflictMild,
  };
  const stage = stageFactor(stages, query.stage, {
    fit: values.stageFit,
    ...severity,
  });
  const care = careContext(query.stage, stages, row.title, row.mesh);
  const phase = phaseConflict(row.mesh, query.stage);
  const own = ownIds(query);
  const foreign = otherDisease(row.mesh, own, query.diagnoses.keys());
  const alternative = otherTreatment(row.mesh, own, query.stage);
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
    (lab ? values.research : 1) *
    (otherSex ? values.population : 1) *
    (foreign ? values.otherDisease : 1) *
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
    drugs.size > 0
      ? "PubTator3 links the patient's drug to the diagnosis."
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
    foreign ? "About another disease." : "",
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
