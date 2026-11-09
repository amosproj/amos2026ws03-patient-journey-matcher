import { expect, test } from "vitest";
import { eventTerms } from "./terms.ts";

test("translates German words and keeps drug names and abbreviations", () => {
  const terms = eventTerms({
    label: "Verlaufskontrolle unter ADT + Olaparib",
    parameters: {
      psa_trend: "rising",
      psa_value: 6.4,
      psa_display: "6,4 ng/ml",
    },
  });

  expect(terms).toEqual(["follow up", "adt", "olaparib", "rising"]);
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
    "adt",
    "plus",
    "parp",
    "inhibitor",
    "bone",
    "metastases",
  ]);
});

test("passes unknown words through and drops function words and numbers", () => {
  expect(eventTerms({ label: "Kontrolle nach 3 Monaten" })).toEqual([
    "monitoring",
    "monaten",
  ]);
});

test("passes through words named like built-in object properties", () => {
  expect(eventTerms({ label: "constructor" })).toEqual(["constructor"]);
});
