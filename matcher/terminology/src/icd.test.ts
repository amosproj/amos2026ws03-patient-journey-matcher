import { expect, test } from "vitest";
import icd from "../data/icd10-mesh.json" with { type: "json" };
import { icdToMesh } from "./icd.ts";
import { mesh } from "./mesh.ts";

const isDisease = (id: string) =>
  id.startsWith("mesh:") && id.slice(5) in mesh.diseases;

test("every reviewed ICD code and category points to a disease", () => {
  for (const [code, id] of Object.entries(icd.codes)) {
    expect(code).toMatch(/^[A-Z]\d{2}(\.\d{1,2})?$/);
    expect(isDisease(id), `${code} → ${id}`).toBe(true);
  }
  for (const [code, id] of Object.entries(icd.categories)) {
    expect(code).toMatch(/^[A-Z]\d{2}$/);
    expect(isDisease(id), `${code} → ${id}`).toBe(true);
  }
});

test("a code with the ICD-10-GM side is read, a code marked suspected not", () => {
  expect(icdToMesh("C50.4 L")).toBe("mesh:D001943");
  expect(icdToMesh("C61 V")).toBeUndefined();
  expect(icdToMesh("F32.1")).toBe("mesh:D003866");
  expect(icdToMesh("F32")).toBeUndefined();
});
