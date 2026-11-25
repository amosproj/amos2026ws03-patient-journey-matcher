import { expect, test } from "vitest";
import {
  conceptOf,
  createTerminology,
  curated,
  defaultTerminology,
  nameDictionary,
  resolve,
  resolveIcd,
} from "./resolve.ts";
import { normalizeName } from "./text.ts";

test.each([
  // A leading code stays; only the resolver tries the name without it.
  ["C61 Prostatakarzinom", "c61 prostatakarzinom"],
  ["P53 mutation", "p53 mutation"],
  ["B12 deficiency", "b12 deficiency"],
  ["(C61)", ""],
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

test("tier 1: reviewed ICD codes, including legacy C61.0; unknown codes are ignored", () => {
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
  expect(resolve({ names: ["prostatitis"] })?.concept.id).toBe("mesh:D011472");
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

test("a leading code is tried away only for the lookup", () => {
  expect(resolve({ names: ["C61 Prostatakarzinom"] })?.concept.id).toBe(
    "mesh:D011471",
  );
  expect(resolve({ names: ["C61.0 Prostatakarzinom"] })?.concept.id).toBe(
    "mesh:D011471",
  );
  expect(resolve({ names: ["P53 mutation"] })).toBeUndefined();
});

test("clinical labels and codes retrieve the same bilingual MeSH concept without assuming a subtype", () => {
  for (const name of [
    "C34",
    "C34.9",
    "Lungenkrebs",
    "lung cancer",
    "Lungenkarzinom",
  ]) {
    expect(resolve({ names: [name] })?.concept.id).toBe("mesh:D008175");
  }
  expect(resolve({ names: ["PCa (C61)"] })).toMatchObject({
    concept: { id: "mesh:D011471" },
    resolvedBy: "icd",
  });
  expect(resolve({ names: ["PCa (C61)"], icdCode: "C50" })).toBeUndefined();
  expect(resolve({ names: ["Lungenkarzinom (C50)"] })).toBeUndefined();
  const lung = resolveIcd("C34");
  expect(lung?.narrower).toContain("mesh:D002289");
  expect(
    resolve({ names: ["non-small cell lung cancer"], icdCode: "C34" })?.concept
      .id,
  ).toBe("mesh:D002289");
  expect(resolve({ names: ["breast cancer"], icdCode: "C34" })).toBeUndefined();
  expect(
    defaultTerminology
      .findDiseases("Confirmed C34.9.")
      .map(({ concept }) => concept.id),
  ).toEqual(["mesh:D008175"]);
  for (const text of [
    "C50-C61",
    "C34.72",
    "C78",
    "M06",
    "MS",
    "RA",
    "PCA",
    "PCa",
  ]) {
    expect(defaultTerminology.findDiseases(text), text).toEqual([]);
  }
});

test("learned names support new IDs and synonyms; conflicting and short names abstain", () => {
  const terms = createTerminology([
    {
      type: "disease",
      id: "mesh:C990001",
      name: "Fixture disease",
      names: ["same label", "xyz"],
    },
    {
      type: "disease",
      id: "mesh:D008175",
      name: "Fixture lung synonym",
      names: ["same label"],
    },
  ]);
  for (const text of ["XYZ", "Same label"]) {
    expect(terms.findDiseases(text)).toEqual([]);
    expect(resolve({ names: [text] }, terms.dictionaries)).toBeUndefined();
  }
  expect(terms.findDiseases("Suspected fixture disease")).toMatchObject([
    { concept: { id: "mesh:C990001" } },
  ]);
  expect(
    resolve({ names: ["Fixture lung synonym"] }, terms.dictionaries),
  ).toMatchObject({
    concept: {
      id: "mesh:D008175",
      name: "Lung Neoplasms",
      names: expect.arrayContaining(["fixture lung synonym"]),
    },
    resolvedBy: "pubtator",
  });
});
