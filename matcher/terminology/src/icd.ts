import icd from "../data/icd10-mesh.json" with { type: "json" };
import { mesh } from "./mesh.ts";

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

/**
 * The MeSH ID of an ICD-10 code as written, else of its category when that names one disease
 * (reviewed in icd10-mesh.json, or mapped exactly by Mondo, from ICD-10-CM only for a code with a
 * subcode). A category is never inferred from its children; a value not shaped like a code is
 * ignored.
 */
export function icdToMesh(code: unknown): string | undefined {
  if (typeof code !== "string") return undefined;
  // ICD-10-GM may add the side (R, L, B) and "gesichert" (G): C50.4 L. A code marked suspected (V),
  // excluded (A) or past (Z) is not read.
  const value = code
    .trim()
    .toUpperCase()
    .replace(/(?<=\d)\s*(?:[RLB]\s*)?G?$/, "");
  if (!ICD_CODE.test(value)) return undefined;
  return (
    ICD_CODES.get(value) ??
    ICD_CATEGORIES.get(value.slice(0, 3)) ??
    (value.includes(".")
      ? ICD_SUBCODE_CATEGORIES.get(value.slice(0, 3))
      : undefined)
  );
}
