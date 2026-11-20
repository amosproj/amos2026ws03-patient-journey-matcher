import { expect, test } from "vitest";
import { statusFromAttribute, statusFromText } from "./status.ts";

const PROSTATE_CANCER = ["prostate cancer", "Prostatakarzinom"];

test.each([
  // The three statements of the graph of Patient-5.
  [
    "An elevated PSA level and suspected prostate cancer are noted as the primary diagnosis and reason for referral.",
    PROSTATE_CANCER,
    { status: "suspected", cue: "suspected" },
  ],
  [
    "The elevated total prostate-specific antigen value of 13,4 ng/ml indicates suspected Prostatakarzinom.",
    PROSTATE_CANCER,
    { status: "suspected", cue: "suspected" },
  ],
  [
    "Patient-5 was referred for diagnostic workup and staging under the suspected diagnosis of Prostatakarzinom.",
    PROSTATE_CANCER,
    { status: "suspected", cue: "suspected diagnosis of" },
  ],
  // The abbreviation of the document headers; its dots do not end the sentence.
  [
    "Lab order with the diagnosis Vd. a. Prostatakarzinom (C61).",
    PROSTATE_CANCER,
    { status: "suspected", cue: "verdacht auf" },
  ],
  [
    "No evidence of bone metastases on PSMA-PET.",
    ["bone metastases"],
    { status: "negated", cue: "no evidence of" },
  ],
  [
    "Kein Hinweis auf Fernmetastasen.",
    ["Fernmetastasen"],
    { status: "negated", cue: "kein hinweis auf" },
  ],
  [
    "Lymph node metastases cannot be ruled out.",
    ["lymph node metastases"],
    { status: "suspected", cue: "cannot be ruled out" },
  ],
  [
    "Knochenmetastasen sind nicht auszuschließen.",
    ["Knochenmetastasen"],
    { status: "suspected", cue: "nicht auszuschliessen" },
  ],
  [
    "Prostate cancer was histologically confirmed.",
    PROSTATE_CANCER,
    { status: "asserted", cue: "histologically confirmed" },
  ],
])("%s", (text, names, expected) => {
  expect(statusFromText(text, names)).toEqual(expected);
});

test("a cue covers the words after it, not before", () => {
  const text = "PSA rise without evidence of metastasis.";
  expect(statusFromText(text, ["PSA"])).toBeUndefined();
  expect(statusFromText(text, ["metastasis"])).toEqual({
    status: "negated",
    cue: "without evidence of",
  });
});

test("the cue next to the name wins, not the first of the sentence", () => {
  const text = "An elevated PSA level and suspected prostate cancer.";
  expect(statusFromText(text, ["elevated PSA level", "PSA"])).toBeUndefined();
});

test("a clause ends at words like but", () => {
  const text = "No local recurrence, but suspected lymph node involvement.";
  expect(statusFromText(text, ["local recurrence"])?.status).toBe("negated");
  expect(statusFromText(text, ["lymph node involvement"])?.status).toBe(
    "suspected",
  );
});

test("a pseudo-negation is no negation", () => {
  expect(
    statusFromText("No change in the bone metastases.", ["bone metastases"]),
  ).toBeUndefined();
});

test("a cue too far from the name does not count", () => {
  const text =
    "No signs of infection were found during the follow-up visit for prostate cancer.";
  expect(statusFromText(text, PROSTATE_CANCER)).toBeUndefined();
});

test("without a cue, or without the name in the sentence, there is no status", () => {
  expect(
    statusFromText("Patient underwent radical prostatectomy.", [
      "radical prostatectomy",
    ]),
  ).toBeUndefined();
  expect(
    statusFromText("Suspected bone metastases.", PROSTATE_CANCER),
  ).toBeUndefined();
});

test("node attributes: only known values", () => {
  expect(statusFromAttribute("active")).toBe("asserted");
  expect(statusFromAttribute("Active")).toBe("asserted");
  expect(statusFromAttribute("resolved")).toBeUndefined();
  expect(statusFromAttribute(null)).toBeUndefined();
});
