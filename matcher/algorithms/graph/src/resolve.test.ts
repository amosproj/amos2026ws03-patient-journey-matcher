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

test("procedures come from MeSH with their kind, role and the qualifier of their papers", () => {
  const find = (text: string) =>
    defaultTerminology.findConcepts(text).map(({ id }) => id);
  const mastectomy = conceptOf("mesh:D008408");
  expect(mastectomy).toMatchObject({ type: "procedure", qualifier: "Q000601" });
  expect(mastectomy?.diagnostic).toBeUndefined();
  expect(find("Mastektomie links, Sentinel Lymph Node Biopsy")).toEqual([
    "mesh:D008408",
    "mesh:D021701",
  ]);
  expect(conceptOf("mesh:D021701")?.diagnostic).toBe(true);
  expect(conceptOf("mesh:D008327")).toMatchObject({
    diagnostic: true,
    qualifier: "Q000000981",
  });
  // Radiosurgery is a radiotherapy, though MeSH also lists it among operations, and an
  // operation that MeSH also lists among endoscopies is an operation.
  expect(conceptOf("mesh:D016634")?.qualifier).toBe("Q000532");
  expect(conceptOf("mesh:D020775")?.qualifier).toBe("Q000601");
  expect(conceptOf("mesh:D020775")?.diagnostic).toBeUndefined();
  expect(conceptOf("mesh:D003113")?.diagnostic).toBe(true);
  expect(find("Hemikolektomie rechts")).toEqual([]);
  expect(find("Hemicolectomy")).toEqual(["mesh:D003082"]);
});

test("whole fields, care settings and ambiguous names are no procedures", () => {
  const find = (text: string) =>
    defaultTerminology.findConcepts(text).map(({ name }) => name);
  expect(find("Behandlung und Nachsorge in der Ambulanz")).toEqual([]);
  expect(find("metastatic castration-resistant")).not.toContain("Castration");
  expect(find("Extension of survival with stem cells")).toEqual([]);
});

test("a MeSH procedure that a curated concept lists as `also` finds that concept", () => {
  const find = (text: string) =>
    defaultTerminology.findConcepts(text).map(({ id }) => id);
  expect(find("Prostate core needle biopsies")).toEqual(["mesh:D001706"]);
  expect(conceptOf("mesh:D062005")).toBeUndefined();
});

test("a code below a reviewed category takes its disease, unless it has its own", () => {
  expect(resolveIcd("C20")?.id).toBe("mesh:D012004");
  expect(resolveIcd("C16.3")?.id).toBe("mesh:D013274");
  expect(resolveIcd("C22.0")?.id).toBe("mesh:D006528");
  expect(resolveIcd("C22.9")?.id).toBe("mesh:D008113");
  // Mixed categories and sites without a MeSH heading stay unmapped.
  expect(resolveIcd("C78.0")).toBeUndefined();
  expect(resolveIcd("C17.1")).toBeUndefined();
});

test("German clinical names of a neoplasm by site find it", () => {
  const id = (name: string) => resolve({ names: [name] })?.concept.id;
  expect(id("Rektumkarzinom")).toBe("mesh:D012004");
  expect(id("Karzinom des Magens")).toBe("mesh:D013274");
  expect(id("Nierentumor")).toBe("mesh:D007680");
  expect(id("Schilddrüsenkarzinom")).toBe("mesh:D013964");
});

test("a code below a category that Mondo maps to one disease takes that disease", () => {
  expect(resolveIcd("E11.74")?.id).toBe("mesh:D003924");
  expect(resolveIcd("N18.4")?.id).toBe("mesh:D007676");
  expect(resolveIcd("G40.3")?.id).toBe("mesh:D004827");
  // Categories Mondo does not map exactly stay unmapped.
  expect(resolveIcd("M06.1")).toBeUndefined();
});
