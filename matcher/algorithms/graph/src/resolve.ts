// Entity resolution (Documentation/design/graph-normalization.md#entities): a patient entity gets
// the ID that PubTator3 uses for the same concept, or none. Tier 1 is the ICD code, tier 2 the
// curated names. Later tiers, such as a dictionary built from stored PubTator3 annotations,
// come in as more `Dictionary` entries; the resolver tries them in order.
import concepts from "../data/concepts.json" with { type: "json" };
import icd from "../data/icd10-mesh.json" with { type: "json" };
import { normalizeName, withoutLeadingCode, words } from "./text.ts";
import type { EntityType, ResolvedBy } from "./types.ts";

export type Concept = {
  id: string;
  type: EntityType;
  name: string;
  names: string[];
  /** IDs of the same concept in another vocabulary, e.g. the MeSH heading of a gene. */
  also?: string[];
  /** Broader concepts a paper may name instead, e.g. radiotherapy for IMRT. */
  broader?: string[];
  /** Narrower diagnoses that imply this one, e.g. castration-resistant prostate cancer. */
  narrower?: string[];
  /** A procedure that finds rather than treats, e.g. a biopsy. */
  diagnostic?: boolean;
  /** The MeSH qualifier of a diagnosis that papers about this concept carry, e.g. surgery. */
  qualifier?: string;
  /** Disease states the concept implies for a patient, e.g. radium-223: castration-resistant. */
  stages?: string[];
  /** The role the matcher gives it instead of the one of its type, e.g. `stage`. */
  role?: string;
  /** A diagnosis only one sex can have, such as prostate cancer. */
  sex?: string;
  /** The diagnosis that giving this shows, for a journey that names none (prostatectomy). */
  implies?: string;
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

const BROADER_DIAGNOSIS: ReadonlyMap<string, string> = new Map(
  [...CONCEPTS.values()].flatMap((concept) =>
    (concept.narrower ?? []).map((narrower) => [narrower, concept.id]),
  ),
);

/** The diagnosis a narrower one is a form of: prostate cancer for castration-resistant. */
export function broaderDiagnosis(id: string): string | undefined {
  return BROADER_DIAGNOSIS.get(id);
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
const ICD_IN_TEXT = /\b[A-Z]\d{2}(?:\.\d{1,2})?\b/gi;

// Longest phrases first so specific diseases (e.g. castration-resistant prostate cancer) win over substrings.
const PHRASES = [...CONCEPTS.values()]
  .flatMap((concept) =>
    [concept.name, ...concept.names].map((name) => ({
      concept,
      phrase: words(name),
    })),
  )
  .filter(({ phrase }) => phrase.length > 0)
  .sort((a, b) => b.phrase.length - a.phrase.length);
const DISEASE_PHRASES = PHRASES.filter(
  ({ concept }) => concept.type === "disease",
);

/** The curated concepts whose names stand on word boundaries in `text`, longest first. */
function findPhrases(text: string, phrases: typeof PHRASES): Concept[] {
  const found: Concept[] = [];
  const tokens = words(text);
  for (let i = 0; i < tokens.length; ) {
    const hit = phrases.find(
      ({ phrase }) =>
        i + phrase.length <= tokens.length &&
        phrase.every((word, offset) => tokens[i + offset] === word),
    );
    if (hit !== undefined) {
      found.push(hit.concept);
      i += hit.phrase.length;
      continue;
    }
    i++;
  }
  return found;
}

/** Curated concepts of any type named in a free-text field, each once. */
export function findConcepts(text: string): Concept[] {
  return [...new Set(findPhrases(text, PHRASES))];
}

/** Curated diseases and mapped ICD-10 codes found on word boundaries in a free-text field. */
export function findDiseases(
  text: string,
): { concept: Concept; code?: string }[] {
  const found: { concept: Concept; code?: string }[] = findPhrases(
    text,
    DISEASE_PHRASES,
  ).map((concept) => ({ concept }));
  for (const [code] of text.matchAll(ICD_IN_TEXT)) {
    const concept = resolveIcd(code);
    if (concept?.type === "disease") found.push({ concept, code });
  }
  return found;
}

/** The ICD names a follow-up can use for an already known diagnosis. */
export function icdCodesFor(id: string): string[] {
  return [...ICD_CODES]
    .filter(([, concept]) => concept === id)
    .map(([code]) => code);
}

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
