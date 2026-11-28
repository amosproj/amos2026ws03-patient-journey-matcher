import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { eventTerms, eventWords, isGeneric } from "./terms.ts";

test("translates German words, spells out abbreviations and keeps drug names", () => {
  const terms = eventTerms({
    label: "Verlaufskontrolle unter ADT + Olaparib",
    parameters: {
      psa_trend: "rising",
      psa_value: 6.4,
      psa_display: "6,4 ng/ml",
    },
  });

  expect(terms).toEqual([
    "follow up",
    "androgen deprivation therapy",
    "olaparib",
    "rising",
  ]);
});

test("splits compounds and snake_case values, and adds true flags by name", () => {
  const terms = eventTerms({
    label: "Ganzkörper-CT: Knochenmetastasen",
    parameters: {
      decision: "adt_plus_parp_inhibitor",
      bone_mets: true,
      liver_mets: false,
    },
  });

  expect(terms).toEqual([
    "whole body",
    "ct",
    "bone metastases",
    "androgen deprivation therapy",
    "parp",
    "inhibitor",
    "bone",
    "metastases",
  ]);
});

test("passes unknown words through and drops function words and numbers", () => {
  expect(eventTerms({ label: "Kontrolle nach 3 Zyklen Lutetium" })).toEqual([
    "monitoring",
    "cycle",
    "lutetium",
  ]);
});

test("leaves out a stable PSA trend", () => {
  // found papers on stable disease under a therapy (#58)
  expect(
    eventTerms({ label: "PSA-Kontrolle", parameters: { psa_trend: "stable" } }),
  ).toEqual(["psa", "monitoring"]);
});

test("passes through words named like built-in object properties", () => {
  expect(eventTerms({ label: "constructor" })).toEqual(["constructor"]);
});

test("translates other German words to their English MeSH heading", () => {
  expect(eventTerms({ label: "Herzinsuffizienz mit Husten" })).toEqual([
    "heart failure",
    "cough",
  ]);
});

test("takes a German MeSH name of several words as one term", () => {
  expect(eventWords({ label: "Rheumatoide Arthritis" })).toEqual([
    { word: "rheumatoide arthritis", term: "arthritis rheumatoid" },
  ]);
});

test("keeps the translation of the list", () => {
  // MeSH: prostatic neoplasms
  expect(eventTerms({ label: "Prostatakarzinom" })).toEqual([
    "prostate cancer",
  ]);
});

test("keeps abbreviations in capitals as papers write them", () => {
  // MeSH: pulmonary disease chronic obstructive
  expect(eventTerms({ label: "COPD, PET-CT" })).toEqual(["copd", "pet", "ct"]);
});

test("does not translate a negated word", () => {
  expect(eventWords({ label: "Keine Herzinsuffizienz" })).toEqual([
    { word: "keine", term: null },
    { word: "herzinsuffizienz", term: null, negated: true },
  ]);
});

test("tells what became of each word", () => {
  expect(eventWords({ label: "Kontrolle nach 3 Zyklen Lutetium" })).toEqual([
    { word: "kontrolle", term: "monitoring" },
    { word: "nach", term: null },
    { word: "3", term: null },
    { word: "zyklen", term: "cycle" },
    { word: "lutetium", term: "lutetium" },
  ]);
});

test("leaves out negated findings, up to the end of their clause", () => {
  const terms = eventTerms({
    label: "PSMA-PET/CT",
    parameters: {
      finding: "Lokalrezidiv in der Prostataloge, keine Fernmetastasen",
      lymph_nodes: "negative",
      r_status: "R0",
    },
  });

  expect(terms).toEqual([
    "psma",
    "pet",
    "ct",
    "local recurrence",
    "prostate bed",
  ]);
  expect(eventTerms({ label: "Kein Nachweis von Fernmetastasen" })).toEqual([]);
  expect(
    eventTerms({
      label: "Knochenmetastasen ohne Schmerzen (Leber unauffällig)",
    }),
  ).toEqual(["bone metastases"]);
});

test('lets "nicht" negate the next searched word, or cancel a negation', () => {
  const terms = (label: string) => eventTerms({ label });

  expect(terms("PSA nicht nachweisbar nach Prostatektomie")).toEqual([
    "psa",
    "prostatectomy",
  ]);
  expect(terms("Nicht metastasiertes Prostatakarzinom")).toEqual([
    "prostate cancer",
  ]);
  expect(terms("PSA nicht mehr nachweisbar")).toEqual(["psa"]);
  expect(terms("Prostatakarzinom nicht in den Samenblasen")).toEqual([
    "prostate cancer",
  ]);
  expect(terms("BRCA2-Mutation nicht ausgeschlossen")).toEqual([
    "brca2",
    "mutation",
  ]);
  expect(terms("Knochenmetastasen nicht sicher ausgeschlossen")).toEqual([
    "bone metastases",
  ]);
});

test("takes a listed phrase as one negation", () => {
  expect(eventTerms({ label: "Lymphknoten nicht befallen" })).toEqual([]);
  expect(
    eventTerms({ label: "Prostatakarzinom, frei von Fernmetastasen" }),
  ).toEqual(["prostate cancer"]);
});

test("marks the words of a negated finding", () => {
  expect(eventWords({ label: "Rezidiv, keine Fernmetastasen" })).toEqual([
    { word: "rezidiv", term: "recurrence" },
    { word: "keine", term: null },
    { word: "fernmetastasen", term: null, negated: true },
  ]);
});

test("does not carry a negation over to the next text", () => {
  const terms = eventTerms({
    label: "Staging",
    parameters: { finding: "kein Lymphknotenbefall", bone_mets: true },
  });

  expect(terms).toEqual(["staging", "bone", "metastases"]);
});

test("leaves out who took part in a tumor board", () => {
  expect(
    eventTerms({
      label: "Tumorkonferenz: RPE",
      parameters: { participants: ["urologie", "strahlentherapie"] },
    }),
  ).toEqual(["tumor board", "radical prostatectomy"]);
});

test("tells generic terms from medical ones", () => {
  expect(
    ["rising", "initial", "follow up", "tumor board"].map(isGeneric),
  ).toEqual([true, true, true, true]);
  expect(["psa", "radiotherapy", "bone metastases"].map(isGeneric)).toEqual([
    false,
    false,
    false,
  ]);
});

// patientdata/ words searched as they are; a new one fails: translate or skip it, or add it here
const UNCHANGED =
  "abdomen abiraterone active alt alternative ap ast bilateral biochemical bone brca2 cabazitaxel castrate castration chemotherapy concurrent ct ct1c ct2a ct2b ct3a deceased declining depot disease docetaxel eau enzalutamide expected extended flare gleason goserelin hb inhibitor initial intention isup latitude ldh liver lymph management molecular multiple mutation nadir node olaparib oncology open pain parp patient pet phosphatase pi primary progression propel prostatectomy psa psma psycho pt2 pt2c radical radiotherapy radium rads recurrence resistance retropubic rising s3 salvage screening short staging stampede suppressed surveillance terminal testing testosterone vinci xofigo".split(
    " ",
  );

test("translates or skips every German word of the synthetic journeys", () => {
  const journeys = new URL("../../../../patientdata/", import.meta.url);
  const unchanged = new Set<string>();
  for (const patient of readdirSync(journeys)) {
    if (!patient.startsWith("Patient-")) continue;
    const timeline = JSON.parse(
      readFileSync(new URL(`${patient}/timeline.json`, journeys), "utf8"),
    );
    for (const event of timeline.events) {
      for (const { word, term } of eventWords(event)) {
        if (term === word) unchanged.add(word);
      }
    }
  }

  expect([...unchanged].sort()).toEqual(UNCHANGED);
});
