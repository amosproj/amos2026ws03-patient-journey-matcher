// Entity resolution (Documentation/graph-normalization.md §4.1): a patient entity gets the
// ID that PubTator3 uses for the same concept, or none. Tier 1 is the ICD code, tier 2 the
// curated names. Later tiers, such as a dictionary built from stored PubTator3 annotations,
// come in as more `Dictionary` entries; the resolver tries them in order.
import concepts from "../data/concepts.json" with { type: "json" };
import icd from "../data/icd10-mesh.json" with { type: "json" };
import { normalizeName, withoutLeadingCode } from "./text.ts";
import type { EntityType, ResolvedBy } from "./types.ts";

export type Concept = {
  id: string;
  type: EntityType;
  name: string;
  names: string[];
};

export type Resolution = {
  concept: Concept;
  resolvedBy: Exclude<ResolvedBy, null>;
};

/** Looks up a normalized name; `undefined` when it does not know it. */
export type Dictionary = {
  resolvedBy: Exclude<ResolvedBy, null>;
  lookup(normalizedName: string): Concept | undefined;
};

const CONCEPTS: ReadonlyMap<string, Concept> = new Map<string, Concept>(
  concepts.concepts.map((concept) => [concept.id, concept as Concept]),
);

/** The curated concept of an ID, with its preferred name and all its names. */
export function conceptOf(id: string): Concept | undefined {
  return CONCEPTS.get(id);
}

/** A dictionary of whole normalized names. A name listed for two concepts is an error. */
export function nameDictionary(
  list: readonly Concept[],
  resolvedBy: Exclude<ResolvedBy, null>,
): Dictionary {
  const byName = new Map<string, Concept>();
  for (const concept of list) {
    for (const name of [concept.name, ...concept.names]) {
      const key = normalizeName(name);
      const known = byName.get(key);
      if (known !== undefined && known.id !== concept.id) {
        throw new Error(
          `"${name}" is a name of ${known.id} and of ${concept.id}.`,
        );
      }
      byName.set(key, concept);
    }
  }
  return { resolvedBy, lookup: (name) => byName.get(name) };
}

/** Tier 2: data/concepts.json. */
export const curated: Dictionary = nameDictionary(
  [...CONCEPTS.values()],
  "curated",
);

const ICD_CODES: ReadonlyMap<string, string> = new Map(
  Object.entries(icd.codes),
);
const ICD_CODE = /^[A-Z]\d{2}(\.\d{1,2})?$/;

/**
 * Tier 1: an ICD-10 code as written, else its three-character category. A value that is not
 * shaped like a code is ignored: the graph takes it from an LLM, unchecked.
 */
export function resolveIcd(code: unknown): Concept | undefined {
  if (typeof code !== "string") return undefined;
  const value = code.trim().toUpperCase();
  if (!ICD_CODE.test(value)) return undefined;
  const id = ICD_CODES.get(value) ?? ICD_CODES.get(value.slice(0, 3));
  return id === undefined ? undefined : CONCEPTS.get(id);
}

/**
 * The first tier that knows the entity: its ICD code, then each dictionary with its names, each
 * as written and then without a leading code (`C61 Prostatakarzinom`).
 */
export function resolve(
  entity: { names: readonly string[]; icdCode?: unknown },
  dictionaries: readonly Dictionary[] = [curated],
): Resolution | undefined {
  const byCode = resolveIcd(entity.icdCode);
  if (byCode !== undefined) return { concept: byCode, resolvedBy: "icd" };
  for (const dictionary of dictionaries) {
    for (const name of entity.names) {
      const normalized = normalizeName(name);
      for (const form of [normalized, withoutLeadingCode(normalized)]) {
        const concept =
          form === undefined ? undefined : dictionary.lookup(form);
        if (concept !== undefined) {
          return { concept, resolvedBy: dictionary.resolvedBy };
        }
      }
    }
  }
  return undefined;
}
