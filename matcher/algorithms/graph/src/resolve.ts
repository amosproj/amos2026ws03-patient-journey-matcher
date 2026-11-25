// Patient and paper concepts share stable MeSH identifiers. All patient lookups are local.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
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

type ProcedureKind =
  | "imaging"
  | "diagnostic"
  | "surgery"
  | "radiotherapy"
  | "drug"
  | "therapy";

type MeshData = {
  diseases: Record<
    string,
    [name: string, aliases: string[], narrower: string[]]
  >;
  chemicals: Record<string, [name: string, aliases: string[]]>;
  procedures: Record<
    string,
    [name: string, aliases: string[], kind: ProcedureKind]
  >;
  histology: string[];
  processes: string[];
  icd: Record<string, string>;
  icd_cm: Record<string, string>;
};

/** MeSH qualifiers of a diagnosis that papers on a procedure of this kind carry. */
export const QUALIFIERS = {
  surgery: "Q000601",
  radiotherapy: "Q000532",
  drug: "Q000188",
  imaging: "Q000000981",
} as const;

const mesh: MeshData = JSON.parse(
  gunzipSync(
    readFileSync(new URL("../data/mesh-terms.json.gz", import.meta.url)),
  ).toString("utf8"),
);

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

const PROSTATE_CANCER = "mesh:D011471";

/** Prostate cancer or one of its forms, such as castration-resistant. */
export function isProstateCancer(id: string): boolean {
  return id === PROSTATE_CANCER || broaderDiagnosis(id) === PROSTATE_CANCER;
}

/** A diagnostic name and a code may describe the same disease at different specificity. */
export function compatibleDiagnoses(a: Concept, b: Concept): boolean {
  return (
    a.id === b.id ||
    Boolean(a.narrower?.includes(b.id) || b.narrower?.includes(a.id))
  );
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

const ICD_CODES = new Map<string, string>([
  ...Object.entries(mesh.icd).map(([code, id]): [string, string] => [
    code,
    `mesh:${id}`,
  ]),
  ...Object.entries(icd.codes),
]);
// Categories whose codes all name one disease: C67.2 is a bladder cancer like C67, E11.9 a type 2
// diabetes like E11. The reviewed ones, and those Mondo maps exactly, which equal one disease.
const ICD_CATEGORIES = new Map<string, string>([
  ...Object.entries(mesh.icd)
    .filter(([code]) => !code.includes("."))
    .map(([code, id]): [string, string] => [code, `mesh:${id}`]),
  ...Object.entries(icd.categories),
]);
// Categories only ICD-10-CM maps (Mondo), for codes with a subcode: F32.1 is a depressive
// disorder. Without one, P53 in a text is more likely the gene.
const ICD_SUBCODE_CATEGORIES = new Map<string, string>(
  Object.entries(mesh.icd_cm).map(([code, id]) => [code, `mesh:${id}`]),
);
const ICD_CODE = /^[A-Z]\d{2}(?:\.\d{1,2})?$/;
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

type Phrase = { concept: Concept; phrase: string[] };
function phraseLookup(names: ReadonlyMap<string, Concept>) {
  const grouped = Map.groupBy(
    [...names]
      .map(([name, concept]): Phrase => ({ concept, phrase: name.split(" ") }))
      .sort((a, b) => b.phrase.length - a.phrase.length),
    ({ phrase }) => phrase[0],
  );
  return (text: string, diseasesOnly = false): Mention[] => {
    const result: Mention[] = [];
    let offset = 0;
    const tokens = words(text);
    for (let i = 0; i < tokens.length; i++) {
      const match = grouped
        .get(tokens[i])
        ?.find(
          ({ concept, phrase }) =>
            (!diseasesOnly || concept.type === "disease") &&
            phrase.every((word, offset) => word === tokens[i + offset]),
        );
      if (match) {
        const mention = match.phrase.join(" ");
        result.push({
          concept: match.concept,
          mention,
          start: offset,
          end: offset + mention.length,
        });
        offset += mention.length + 1;
        i += match.phrase.length - 1;
      } else offset += tokens[i].length + 1;
    }
    return result;
  };
}

/** Single-ID aliases after normalization. A short abbreviation needs a reviewed clinical meaning. */
function indexedNames(list: Iterable<Concept>): Map<string, Concept | null> {
  const result = new Map<string, Concept | null>();
  for (const concept of list) {
    for (const name of [concept.name, ...concept.names]) {
      const key = normalizeName(name);
      if (key.length < 4 || !/\p{L}/u.test(key)) continue;
      const known = result.get(key);
      result.set(
        key,
        known === undefined || known?.id === concept.id ? concept : null,
      );
    }
  }
  return result;
}

const staticNames = indexedNames(MESH_CONCEPTS.values());
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
  const corpusNames = indexedNames(corpus);
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
  const find = phraseLookup(names);
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

/**
 * Tier 1: a mapped ICD-10 code as written, else its category when that names one disease (reviewed in
 * icd10-mesh.json, or mapped exactly by Mondo, from ICD-10-CM only for a code with a subcode). A category is
 * never inferred from its children. A value that is not shaped like a code is ignored: the graph takes it from
 * an LLM, unchecked.
 */
export function resolveIcd(code: unknown): Concept | undefined {
  if (typeof code !== "string") return undefined;
  // ICD-10-GM may add the side (R, L, B) and "gesichert" (G): C50.4 L. A code marked suspected (V),
  // excluded (A) or past (Z) is not read.
  const value = code
    .trim()
    .toUpperCase()
    .replace(/(?<=\d)\s*(?:[RLB]\s*)?G?$/, "");
  if (!ICD_CODE.test(value)) return undefined;
  const id =
    ICD_CODES.get(value) ??
    ICD_CATEGORIES.get(value.slice(0, 3)) ??
    (value.includes(".")
      ? ICD_SUBCODE_CATEGORIES.get(value.slice(0, 3))
      : undefined);
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
