import type { Hit, Matcher } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { patientQuery } from "./query.ts";
import { rerank } from "./rerank.ts";
import { defaultTerminology, type Terminology } from "./resolve.ts";
import { shortlist } from "./retrieval.ts";
import { queryWeights, settings } from "./settings.ts";

export function createGraphMatcher(
  db: Queryable,
  terminology: () => Promise<Terminology> = async () => defaultTerminology,
): Matcher {
  return {
    async match(state, { contentTypes, limit, tuning, trace }) {
      const values = settings(tuning);
      const terms = await terminology();
      const query = patientQuery(state, queryWeights(values), terms);
      // At confirmation a paper studying a treatment for the disease is relevant even
      // when the patient has never received that drug.
      const diagnosisOnly =
        query.stage.diagnosed &&
        !query.concepts.some(
          (c) => c.role !== "diagnosis" && c.role !== "aspect" && c.focus,
        ) &&
        !query.treatments.size;
      const { states, flags, ...course } = query.stage;
      trace?.("query", {
        cutoff: query.cutoff,
        focusDate: state.focus.date,
        conceptOnly: query.conceptOnly,
        diagnoses: Object.fromEntries(query.diagnoses),
        profiles: query.profiles.map(
          ({ diagnosis }) => terms.conceptOf(diagnosis)?.name ?? diagnosis,
        ),
        // with names, as a ruled-out kind is no patient concept
        histologies: query.histologies.map((histology) => ({
          ...histology,
          names: Object.fromEntries(
            [histology.observed, histology.conflicting].map((id) => [
              id,
              terms.conceptOf(id)?.name ?? id,
            ]),
          ),
        })),
        concepts: query.concepts,
        stage: { ...course, ...flags, states: [...states] },
        treatments: Object.fromEntries(query.treatments),
        relations: Object.fromEntries(query.relations),
        evidence: query.evidence,
      });
      if (!query.diagnoses.size) return [];
      const rows = await shortlist(
        db,
        query,
        values,
        diagnosisOnly,
        contentTypes,
      );
      // Not "candidates": the debug UI reads that step as keyword's list.
      trace?.("pool", {
        reranked: rows.length,
        named: rows[0]?.named ?? 0,
        idf: Object.fromEntries(
          query.concepts.map((concept, index) => [
            concept.ids[0],
            rows[0]?.idf[index] ?? 0,
          ]),
        ),
      });
      const hits = rerank(query, rows, values, terms, diagnosisOnly).slice(
        0,
        limit,
      );
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
