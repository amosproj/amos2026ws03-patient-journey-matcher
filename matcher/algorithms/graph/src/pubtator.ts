// PubTator3 annotations of one paper → NormalizedGraph (Documentation/graph-normalization.md §2).
// Reads the BioC JSON of `publications/export/biocjson`: the entity annotations and the
// relations. The passage text is not read, so nothing of the abstract is kept.
import { z } from "zod";
import outcomes from "../data/outcomes.json" with { type: "json" };
import { DROPPED_PUBTATOR_TYPES, mapPubTatorRelation } from "./relations.ts";
import { normalizeName } from "./text.ts";
import {
  type EntityType,
  type NormalizedEntity,
  type NormalizedGraph,
  type NormalizedRelation,
  type Predicate,
  type Skipped,
  SYMMETRIC,
} from "./types.ts";

const conceptSchema = z.object({
  type: z.string(),
  identifier: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
});

const documentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  pmid: z.union([z.string(), z.number()]).nullish(),
  passages: z.array(
    z.object({
      annotations: z
        .array(z.object({ infons: conceptSchema, text: z.string().nullish() }))
        .default([]),
    }),
  ),
  relations: z
    .array(
      z.object({
        id: z.string(),
        infons: z.object({
          type: z.string(),
          score: z.union([z.string(), z.number()]).nullish(),
          role1: conceptSchema,
          role2: conceptSchema,
        }),
      }),
    )
    .default([]),
});

export type PubTatorDocument = z.input<typeof documentSchema>;

const TYPES: Record<string, EntityType | undefined> = {
  Disease: "disease",
  Chemical: "chemical",
  Gene: "gene",
  Variant: "variant",
  Mutation: "variant",
  DNAMutation: "variant",
  ProteinMutation: "variant",
  SNP: "variant",
};

const OUTCOMES: ReadonlySet<string> = new Set(outcomes.ids);
const OUTCOME_PREDICATES: Partial<Record<Predicate, Predicate>> = {
  treats: "improves_outcome",
  causes: "worsens_outcome",
};

/** The documents of an export (`{ PubTator3: [...] }`), a list of documents, or one document. */
export function pubTatorDocuments(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (typeof json === "object" && json !== null && "PubTator3" in json) {
    const list = (json as { PubTator3: unknown }).PubTator3;
    if (Array.isArray(list)) return list;
  }
  return [json];
}

/** `MESH:D011471` → `mesh:D011471`, `672` → `ncbigene:672`; several IDs are split at `;`. */
function conceptIds(
  type: EntityType,
  identifier: string | number | null | undefined,
): string[] {
  if (identifier === null || identifier === undefined) return [];
  return String(identifier)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "-")
    .map((part) => {
      if (type === "gene") return `ncbigene:${part}`;
      if (type === "variant")
        return /^rs\d+$/i.test(part) ? `dbsnp:${part}` : `hgvs:${part}`;
      const mesh = /^mesh:(.+)$/i.exec(part);
      return mesh === null ? part.toLowerCase() : `mesh:${mesh[1]}`;
    });
}

/**
 * The entities and relations of one paper. Relations below `minScore` are left out; several
 * relations with the same triple become one, with the highest score.
 */
export function normalizePubTatorDocument(
  input: unknown,
  { minScore = 0 }: { minScore?: number } = {},
): NormalizedGraph {
  const document = documentSchema.parse(input);
  const pmid = String(document.pmid ?? document.id);
  const entities = new Map<string, NormalizedEntity>();
  const skipped: Skipped[] = [];

  // The keys of a concept, adding it as an entity; empty for a type that is not read.
  function add(
    concept: z.output<typeof conceptSchema>,
    mention: string | null | undefined,
  ): string[] {
    const type = TYPES[concept.type];
    if (type === undefined) return [];
    const names = [mention, concept.name].filter(
      (name): name is string => typeof name === "string" && name.trim() !== "",
    );
    const ids = conceptIds(type, concept.identifier);
    const keys: { key: string; id: string | null }[] =
      ids.length > 0
        ? ids.map((id) => ({ key: id, id }))
        : names.length > 0
          ? [{ key: `name:${normalizeName(names[0])}`, id: null }]
          : [];
    for (const { key, id } of keys) {
      const known = entities.get(key);
      if (known === undefined) {
        entities.set(key, {
          key,
          id,
          type,
          name: concept.name ?? names[0] ?? key,
          names: [...new Set(names)],
          resolvedBy: id === null ? null : "pubtator",
          labels: [concept.type],
          sources: [pmid],
        });
      } else {
        known.names = [...new Set([...known.names, ...names])];
      }
    }
    return keys.map(({ key }) => key);
  }

  for (const passage of document.passages) {
    for (const annotation of passage.annotations) {
      if (DROPPED_PUBTATOR_TYPES.has(annotation.infons.type)) continue;
      add(annotation.infons, annotation.text);
    }
  }

  const relations = new Map<string, NormalizedRelation>();
  for (const relation of document.relations) {
    const { type, role1, role2 } = relation.infons;
    const ref = `${pmid}:${relation.id}`;
    const score =
      relation.infons.score == null ? undefined : Number(relation.infons.score);
    if (score !== undefined && score < minScore) {
      skipped.push({ ref, type, reason: `score ${score} below ${minScore}` });
      continue;
    }
    const firsts = add(role1, undefined);
    const seconds = add(role2, undefined);
    if (firsts.length === 0 || seconds.length === 0) {
      skipped.push({
        ref,
        type,
        reason: `role of type ${role1.type} or ${role2.type} not read`,
      });
      continue;
    }
    const mapped = mapPubTatorRelation(type, role1.type, role2.type);
    for (const first of firsts) {
      for (const second of seconds) {
        let [subject, object] = mapped.flip ? [second, first] : [first, second];
        let predicate = mapped.predicate;
        if (OUTCOMES.has(object))
          predicate = OUTCOME_PREDICATES[predicate] ?? predicate;
        if (SYMMETRIC.has(predicate) && object < subject)
          [subject, object] = [object, subject];
        const key = `${subject}|${predicate}|${object}`;
        const known = relations.get(key);
        if (known !== undefined && (known.score ?? 0) >= (score ?? 0)) continue;
        relations.set(key, {
          subject,
          predicate,
          object,
          status: "asserted",
          score,
          origin: { source: "pubtator", ref, type },
        });
      }
    }
  }

  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
    facts: [],
    skipped,
  };
}
