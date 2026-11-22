// PubTator3 annotations of one paper → NormalizedGraph
// (Documentation/design/graph-normalization.md). Reads the BioC JSON of
// `publications/export/biocjson`: the entity annotations and the relations. The passage text
// is not read, so nothing of the abstract is kept.
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

const TYPES: ReadonlyMap<string, EntityType> = new Map([
  ["Disease", "disease"],
  ["Chemical", "chemical"],
  ["Gene", "gene"],
  ["Variant", "variant"],
]);

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

/**
 * `MESH:D011471` → `mesh:D011471`, `672` → `ncbigene:672`; several IDs are split at `;`. A
 * variant has one ID in parts (`tmVar:…;HGVS:p.V600E;CorrespondingGene:673;RS#:113488022`),
 * in another order in a relation: its dbSNP number, else its HGVS name with the gene, else
 * none, as `C>G` alone names no one variant.
 */
function conceptIds(
  type: EntityType,
  identifier: string | number | null | undefined,
): string[] {
  if (identifier === null || identifier === undefined) return [];
  const parts = String(identifier)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "-");
  if (type === "variant") {
    const part = (name: string) =>
      parts.find((one) => one.startsWith(`${name}:`))?.slice(name.length + 1);
    const [rs, hgvs, gene] = ["RS#", "HGVS", "CorrespondingGene"].map(part);
    if (rs !== undefined) return [`dbsnp:rs${rs}`];
    if (hgvs === undefined) return [];
    return [`hgvs:${gene === undefined ? "" : `${gene}:`}${hgvs}`];
  }
  return parts.map((part) => {
    if (type === "gene") return `ncbigene:${part}`;
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
    const type = TYPES.get(concept.type);
    if (type === undefined) return [];
    // A name with nothing left after normalizing (`(C61)`, `-`) is no name: it would merge
    // every such entity under one key.
    const names = [mention, concept.name].filter(
      (name): name is string =>
        typeof name === "string" && normalizeName(name) !== "",
    );
    const ids = conceptIds(type, concept.identifier);
    // A variant without an ID is not kept by its name: that is a placeholder (`#7157#`).
    if (type === "variant" && ids.length === 0) return [];
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

  // Annotations of a type that is not read and variants without an ID, counted per type: one
  // `skipped` row each.
  const leftOut = new Map<string, number>();
  for (const passage of document.passages) {
    for (const annotation of passage.annotations) {
      const { type } = annotation.infons;
      const read = !DROPPED_PUBTATOR_TYPES.has(type) && TYPES.has(type);
      const keys = read ? add(annotation.infons, annotation.text) : [];
      if (!read || (type === "Variant" && keys.length === 0))
        leftOut.set(type, (leftOut.get(type) ?? 0) + 1);
    }
  }
  for (const [type, count] of leftOut) {
    const why = DROPPED_PUBTATOR_TYPES.has(type)
      ? "left out"
      : TYPES.has(type)
        ? "without a dbSNP number or HGVS name"
        : "of a type not read";
    skipped.push({
      ref: pmid,
      type,
      reason: `${count} ${type} annotation${count === 1 ? "" : "s"} ${why}`,
    });
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
    // Roles with several IDs (`672;675`) pair up each with each, except an ID with itself.
    let pairs = 0;
    for (const first of firsts) {
      for (const second of seconds) {
        if (first === second) continue;
        pairs++;
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
    if (pairs === 0)
      skipped.push({ ref, type, reason: "both ends are the same entity" });
  }

  return {
    entities: [...entities.values()],
    relations: [...relations.values()],
    facts: [],
    skipped,
  };
}
