// The data files are cast to their types, not parsed, so a typo would pass silently. These
// tests check them against each other and against the lists the types are made from.
import { expect, test } from "vitest";
import concepts from "../data/concepts.json" with { type: "json" };
import icd from "../data/icd10-mesh.json" with { type: "json" };
import outcomes from "../data/outcomes.json" with { type: "json" };
import patient from "../data/patient-relations.json" with { type: "json" };
import pubtator from "../data/pubtator-relations.json" with { type: "json" };
import cues from "../data/status-cues.json" with { type: "json" };
import { CUE_STATUSES } from "./status.ts";
import { normalizeName } from "./text.ts";
import { ENTITY_TYPES, FACT_KINDS, PREDICATES, STATUSES } from "./types.ts";

type Row = { type: string } & Record<string, unknown>;
const PATIENT_ROWS = patient.rows as Row[];
const PUBTATOR_ROWS = pubtator.rows as Row[];

const CONCEPT_IDS = new Set(concepts.concepts.map(({ id }) => id));
const ID = /^(mesh:[CD]\d+|ncbigene:\d+)$/;

test("concepts: a known type, a well-formed ID, each ID once", () => {
  for (const concept of concepts.concepts) {
    expect(ENTITY_TYPES, concept.id).toContain(concept.type);
    expect(concept.id).toMatch(ID);
    expect(concept.name.trim(), concept.id).not.toBe("");
  }
  expect(CONCEPT_IDS.size).toBe(concepts.concepts.length);
});

test("every ICD code points to a curated concept", () => {
  for (const [code, id] of Object.entries(icd.codes)) {
    expect(code).toMatch(/^[A-Z]\d{2}(\.\d{1,2})?$/);
    expect(CONCEPT_IDS, `${code} → ${id}`).toContain(id);
  }
});

test("outcome IDs are well-formed", () => {
  for (const id of outcomes.ids) expect(id).toMatch(ID);
});

test.each([
  // PubTator3 rows may only map: a drop or fact row would silently become `related`.
  ["patient", PATIENT_ROWS, ["drop", "fact", "predicate"]],
  ["pubtator", PUBTATOR_ROWS, ["predicate"]],
])("%s rows: exactly one of %j, with valid values", (_, rows, allowed) => {
  for (const row of rows) {
    const what = JSON.stringify(row);
    const kinds = ["drop", "fact", "predicate"].filter((key) => key in row);
    expect(kinds, what).toHaveLength(1);
    expect(allowed, what).toContain(kinds[0]);
    if ("predicate" in row) expect(PREDICATES, what).toContain(row.predicate);
    if ("fact" in row) expect(FACT_KINDS, what).toContain(row.fact);
    if (row.fact === "has_condition")
      expect(["diagnosis", "symptom", "allergy"], what).toContain(
        row.conditionRole,
      );
    if ("status" in row) expect(STATUSES, what).toContain(row.status);
    if ("about" in row) expect(row.about, what).toBe("source");
    if ("flip" in row) expect(typeof row.flip, what).toBe("boolean");
    if ("confirms" in row) expect(row.confirms, what).toBe(true);
  }
});

test("a specific row comes before the catch-all row of its type", () => {
  for (const rows of [PATIENT_ROWS, PUBTATOR_ROWS]) {
    rows.forEach((row, index) => {
      if (row.subject !== undefined || row.object !== undefined) return;
      const later = rows
        .slice(index + 1)
        .filter((other) => other.type === row.type);
      expect(later, `after the catch-all ${row.type}`).toEqual([]);
    });
  }
});

test("status cues: valid status, position and window, each written once", () => {
  const seen = new Set<string>();
  for (const cue of cues.cues) {
    const what = JSON.stringify(cue);
    expect(CUE_STATUSES, what).toContain(cue.status);
    expect(["pre", "post"], what).toContain(cue.position);
    if ("window" in cue) {
      expect(Number.isInteger(cue.window), what).toBe(true);
      expect(cue.window, what).toBeGreaterThanOrEqual(0);
    }
    const key = `${normalizeName(cue.text)} ${cue.position}`;
    expect(seen, `${what} twice`).not.toContain(key);
    seen.add(key);
  }
});

test("attribute values give a status", () => {
  for (const status of Object.values(cues.attributes)) {
    expect(STATUSES).toContain(status);
  }
});
