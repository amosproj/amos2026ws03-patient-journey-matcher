// Patient and paper concepts share stable MeSH identifiers. All patient lookups are local.
import {
  icdToMesh,
  mesh,
  nameIndex,
  normalizeName,
  phraseLookup,
  withoutLeadingCode,
  words,
} from "@matcher/terminology";
import concepts from "../data/concepts.json" with { type: "json" };
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

/** MeSH qualifiers of a diagnosis that papers on a procedure of this kind carry. */
export const QUALIFIERS = {
  surgery: "Q000601",
  radiotherapy: "Q000532",
  drug: "Q000188",
  imaging: "Q000000981",
} as const;

const MESH_CONCEPTS = new Map<string, Concept>(
  Object.entries(mesh.diseases).map(
    ([descriptor, [name, names, descendants]]) => {
      const id = `mesh:${descriptor}`;
      const clinical = CONCEPTS.get(id);
      return [
        id,
        {
          id,
          name,
          type: "disease",
          ...(descendants.length && {
            narrower: descendants.map((child) => `mesh:${child}`),
          }),
          ...clinical,
          names: [...new Set([name, ...names, ...(clinical?.names ?? [])])],
        },
      ];
    },
  ),
);

for (const [key, [name, names]] of Object.entries(mesh.chemicals)) {
  const id = `mesh:${key}`;
  const clinical = CONCEPTS.get(id);
  MESH_CONCEPTS.set(id, {
    id,
    name,
    type: "chemical",
    ...clinical,
    names: [...new Set([name, ...names, ...(clinical?.names ?? [])])],
  });
}

// A procedure that a curated concept lists as `also` is that concept: core needle biopsy is a
// biopsy, a PET a PET/CT. Its names find the curated concept.
const ALSO_OF = new Map(
  [...CONCEPTS.values()].flatMap((concept) =>
    (concept.also ?? [])
      .filter((id) => !CONCEPTS.has(id))
      .map((id): [string, string] => [id, concept.id]),
  ),
);
const alsoNames: [string, string[]][] = [];
for (const [key, [name, names, kind]] of Object.entries(mesh.procedures)) {
  const id = `mesh:${key}`;
  const owner = ALSO_OF.get(id);
  if (owner !== undefined) {
    alsoNames.push([owner, [name, ...names]]);
    continue;
  }
  const clinical = CONCEPTS.get(id);
  const qualifier =
    kind in QUALIFIERS
      ? QUALIFIERS[kind as keyof typeof QUALIFIERS]
      : undefined;
  MESH_CONCEPTS.set(id, {
    id,
    name,
    type: "procedure",
    ...((kind === "imaging" || kind === "diagnostic") && { diagnostic: true }),
    ...(qualifier && { qualifier }),
    ...clinical,
    names: [...new Set([name, ...names, ...(clinical?.names ?? [])])],
  });
}
for (const [owner, names] of alsoNames) {
  const concept = MESH_CONCEPTS.get(owner) ?? CONCEPTS.get(owner);
  if (concept)
    MESH_CONCEPTS.set(owner, {
      ...concept,
      names: [...new Set([...concept.names, ...names])],
    });
}

/** Kinds of carcinoma that name no site, such as carcinoma in situ (build-terminology.py). */
export const HISTOLOGY: ReadonlySet<string> = new Set(
  mesh.histology.map((descriptor) => `mesh:${descriptor}`),
);

/** What a tumour does, such as lymphatic metastasis or a residual tumour (build-terminology.py). */
export const PROCESSES: ReadonlySet<string> = new Set(
  mesh.processes.map((descriptor) => `mesh:${descriptor}`),
);

export function conceptOf(id: string): Concept | undefined {
  return MESH_CONCEPTS.get(id) ?? CONCEPTS.get(id);
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

/** A diagnostic name and a code may describe the same disease at different specificity. */
export function compatibleDiagnoses(a: Concept, b: Concept): boolean {
  return (
    a.id === b.id ||
    Boolean(a.narrower?.includes(b.id) || b.narrower?.includes(a.id))
  );
}

// In a text a code is written in capitals and stands alone: HLA-B27, p53 and F18-FDG are names. As
// in resolveIcd, a code marked suspected, excluded or past (C61 V, C61 A, C61 Z) is not read.
const ICD_IN_TEXT =
  /(?<![\p{L}\p{N}-])[A-Z]\d{2}(?:\.\d+)?(?:\s*[-–—]\s*[A-Z]\d{2}(?:\.\d+)?)?(?![\p{L}\p{N}]|\.[\p{L}\p{N}]|-\p{L}|\s+[VAZ]\b)/gu;

type Mention = {
  concept: Concept;
  mention: string;
  start: number;
  end: number;
};
type DiseaseHit = { concept: Concept; mention: string; code?: string };
export type Terminology = {
  dictionaries: readonly Dictionary[];
  conceptOf(id: string): Concept | undefined;
  findConcepts(text: string): Concept[];
  /** Longest matched names and their character offsets in normalized text. */
  findMentions(text: string): Mention[];
  findDiseases(text: string): DiseaseHit[];
};

/** Longest matched names and their character offsets in the normalized text. */
function mentionLookup(names: ReadonlyMap<string, Concept>) {
  const find = phraseLookup(names);
  return (text: string, diseasesOnly = false): Mention[] => {
    const tokens = words(text);
    const offsets = [0];
    for (const token of tokens)
      offsets.push((offsets.at(-1) ?? 0) + token.length + 1);
    return find(
      tokens,
      diseasesOnly ? (concept) => concept.type === "disease" : undefined,
    ).map(({ value, start, end }) => {
      const mention = tokens.slice(start, end).join(" ");
      return {
        concept: value,
        mention,
        start: offsets[start],
        end: offsets[start] + mention.length,
      };
    });
  };
}

const conceptNames = (concept: Concept) => [concept.name, ...concept.names];

const staticNames = nameIndex(MESH_CONCEPTS.values(), conceptNames);
const clinicalNames = new Map<string, Concept>();
for (const row of CONCEPTS.values()) {
  const concept = conceptOf(row.id) ?? row;
  for (const name of [row.name, ...row.names])
    clinicalNames.set(normalizeName(name), concept);
}

export function createTerminology(
  corpus: readonly Concept[] = [],
): Terminology {
  const corpusById = new Map<string, Concept>();
  const corpusNames = nameIndex(corpus, conceptNames);
  // Published names (including collisions) and reviewed overrides take precedence over annotations.
  const combined = new Map([...corpusNames, ...staticNames, ...clinicalNames]);
  const names = new Map<string, Concept>();
  for (const [alias, concept] of combined) {
    if (!concept) continue;
    const standard = conceptOf(concept.id);
    let canonical = corpusById.get(concept.id);
    if (
      !canonical &&
      corpusNames.get(alias)?.id === concept.id &&
      !staticNames.has(alias)
    ) {
      canonical = {
        ...(standard ?? concept),
        names: [...(standard?.names ?? [])],
      };
      corpusById.set(concept.id, canonical);
    }
    if (canonical && !staticNames.has(alias)) canonical.names.push(alias);
  }
  const byId = (id: string) => corpusById.get(id) ?? conceptOf(id);
  for (const [alias, concept] of combined) {
    if (concept) names.set(alias, byId(concept.id) ?? concept);
  }
  const find = mentionLookup(names);
  const dictionaries: Dictionary[] = [
    {
      resolvedBy: "curated",
      lookup: (key) => (clinicalNames.has(key) ? names.get(key) : undefined),
    },
    {
      resolvedBy: "mesh",
      lookup: (key) => (staticNames.has(key) ? names.get(key) : undefined),
    },
    { resolvedBy: "pubtator", lookup: (key) => names.get(key) },
  ];
  return {
    dictionaries,
    conceptOf: byId,
    findMentions: find,
    findConcepts: (text) => [...new Set(find(text).map((hit) => hit.concept))],
    findDiseases(text) {
      const found: DiseaseHit[] = find(text, true);
      for (const [code] of text.matchAll(ICD_IN_TEXT)) {
        const concept = resolveIcd(code);
        if (concept?.type === "disease")
          found.push({
            concept: byId(concept.id) ?? concept,
            mention: code,
            code,
          });
      }
      return found;
    },
  };
}

export const defaultTerminology = createTerminology();

/** A code of a secondary neoplasm, such as C78.7 for liver metastases. */
export function isSpread(code: unknown): boolean {
  return typeof code === "string" && /^\s*C7[7-9](?![0-9])/i.test(code);
}

/**
 * Tier 1: a mapped ICD-10 code as written, else its category when that names one disease (reviewed in
 * icd10-mesh.json, or mapped exactly by Mondo, from ICD-10-CM only for a code with a subcode). A category is
 * never inferred from its children. A value that is not shaped like a code is ignored: the graph takes it from
 * an LLM, unchecked.
 */
export function resolveIcd(code: unknown): Concept | undefined {
  const id = icdToMesh(code);
  return id === undefined ? undefined : conceptOf(id);
}

/**
 * The first tier that knows the entity: its ICD code, then each dictionary with its names, each
 * as written and then without a leading code (`C61 Prostatakarzinom`).
 */
export function resolve(
  entity: { names: readonly string[]; icdCode?: unknown },
  dictionaries: readonly Dictionary[] = defaultTerminology.dictionaries,
): Resolution | undefined {
  let byCode = resolveIcd(entity.icdCode);
  for (const name of entity.names) {
    // Graphiti writes a code at the beginning of the label or in parentheses.
    const codes = name.matchAll(
      /(?:^\s*([A-Z]\d{2}(?:\.\d{1,2})?)(?=\s|$)|\(\s*([A-Z]\d{2}(?:\.\d{1,2})?)\s*\))/g,
    );
    for (const [, leading, bracketed] of codes) {
      const concept = resolveIcd(leading ?? bracketed);
      if (concept && byCode && !compatibleDiagnoses(concept, byCode))
        return undefined;
      if (concept && (!byCode || byCode.narrower?.includes(concept.id)))
        byCode = concept;
    }
  }
  for (const dictionary of dictionaries) {
    for (const name of entity.names) {
      const normalized = normalizeName(name);
      for (const form of [normalized, withoutLeadingCode(normalized)]) {
        const concept =
          form === undefined ? undefined : dictionary.lookup(form);
        if (concept !== undefined) {
          if (byCode && concept.narrower?.includes(byCode.id))
            return { concept: byCode, resolvedBy: "icd" };
          if (!byCode || compatibleDiagnoses(byCode, concept))
            return {
              concept,
              resolvedBy:
                byCode?.id === concept.id ? "icd" : dictionary.resolvedBy,
            };
          return undefined; // conflicting explicit disease evidence
        }
      }
    }
  }
  return byCode && { concept: byCode, resolvedBy: "icd" };
}
