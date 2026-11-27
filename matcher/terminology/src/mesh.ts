import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export type ProcedureKind =
  | "imaging"
  | "diagnostic"
  | "surgery"
  | "radiotherapy"
  | "drug"
  | "therapy";

/** German MeSH 2026 and its ICD-10 mappings, built by scripts/build-terminology.py. */
export type MeshData = {
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

export const mesh: MeshData = JSON.parse(
  gunzipSync(
    readFileSync(new URL("../data/mesh-terms.json.gz", import.meta.url)),
  ).toString("utf8"),
);
