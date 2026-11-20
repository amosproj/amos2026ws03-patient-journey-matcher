import { expect, test } from "vitest";
import {
  conceptOf,
  curated,
  nameDictionary,
  resolve,
  resolveIcd,
} from "./resolve.ts";
import { normalizeName } from "./text.ts";

test.each([
  ["C61 Prostatakarzinom", "prostatakarzinom"],
  ["Vd. a. Prostatakarzinom (C61)", "vd a prostatakarzinom"],
  ["PSMA-PET/CT", "psma pet ct"],
  ["Aktive Überwachung", "aktive uberwachung"],
  [
    "Knochenmetastasen sind nicht auszuschließen",
    "knochenmetastasen sind nicht auszuschliessen",
  ],
  ["Radium-223 (Xofigo)", "radium 223 xofigo"],
  ["  RPE ", "rpe"],
])("normalizeName(%j) = %j", (text, expected) => {
  expect(normalizeName(text)).toBe(expected);
});

test("tier 1: an ICD code, else its category; an odd value is ignored", () => {
  expect(resolveIcd("C61")?.id).toBe("mesh:D011471");
  expect(resolveIcd(" c61 ")?.id).toBe("mesh:D011471");
  expect(resolveIcd("C61.0")?.id).toBe("mesh:D011471");
  expect(resolveIcd("C78.7")?.id).toBe("mesh:D008113");
  expect(resolveIcd("C78")).toBeUndefined();
  expect(resolveIcd("prostate")).toBeUndefined();
  expect(resolveIcd(null)).toBeUndefined();
});

test("the ICD code comes before the name", () => {
  expect(resolve({ names: ["something else"], icdCode: "C61" })).toMatchObject({
    concept: { id: "mesh:D011471" },
    resolvedBy: "icd",
  });
});

test.each([
  ["C61 Prostatakarzinom", "mesh:D011471"],
  ["prostate cancer", "mesh:D011471"],
  ["Adenokarzinom der Prostata", "mesh:D011471"],
  ["leuprorelin", "mesh:D016729"],
  ["Abirateron", "mesh:C089740"],
  ["RPE", "mesh:D011468"],
  ["Prostatastanzbiopsien", "mesh:D001706"],
  ["elevated PSA level", "ncbigene:354"],
  ["transurethral indwelling catheter", "mesh:D062885"],
])("tier 2: %s → %s", (name, id) => {
  expect(resolve({ names: [name] })).toMatchObject({
    concept: { id },
    resolvedBy: "curated",
  });
});

test("names match whole: no containment, no fuzzy match", () => {
  expect(resolve({ names: ["PSMA-PET/CT imaging procedure"] })).toBeUndefined();
  expect(
    resolve({ names: ["Biochemisches Rezidiv – Salvage-Therapie"] }),
  ).toBeUndefined();
  expect(resolve({ names: ["prostatitis"] })).toBeUndefined();
});

test("the concept table decides the type, not the patient label", () => {
  expect(conceptOf("mesh:D062885")?.type).toBe("device");
  expect(conceptOf("ncbigene:354")?.type).toBe("gene");
});

test("more dictionaries come after the curated one, in order", () => {
  const corpus = nameDictionary(
    [
      {
        id: "mesh:D000000",
        type: "chemical",
        name: "Somedrug",
        names: ["somedrug"],
      },
    ],
    "pubtator",
  );
  expect(resolve({ names: ["somedrug"] }, [curated, corpus])).toMatchObject({
    concept: { id: "mesh:D000000" },
    resolvedBy: "pubtator",
  });
  expect(
    resolve({ names: ["leuprorelin"] }, [curated, corpus])?.resolvedBy,
  ).toBe("curated");
});

test("a name of two concepts is an error", () => {
  expect(() =>
    nameDictionary(
      [
        { id: "mesh:A", type: "disease", name: "a", names: ["same"] },
        { id: "mesh:B", type: "disease", name: "b", names: ["same"] },
      ],
      "curated",
    ),
  ).toThrow(/"same" is a name of mesh:A and of mesh:B/);
});
