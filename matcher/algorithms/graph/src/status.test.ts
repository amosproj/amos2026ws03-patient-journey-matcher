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

test("ruling out a drug for a disease does not rule out the disease", () => {
  const text = "Olaparib was ruled out for breast cancer.";
  expect(statusFromText(text, ["Olaparib"])?.status).toBe("negated");
  expect(statusFromText(text, ["breast cancer"])).toBeUndefined();
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
  expect(statusFromAttribute("confirmed")).toBe("asserted");
  expect(statusFromAttribute("resolved")).toBeUndefined();
  expect(statusFromAttribute(null)).toBeUndefined();
});

// Regressions of the review of #80: bare negations reach only the next words, and negated
// cues ("not ruled out", "not confirmed") are not their positive halves.
test.each([
  ["Patient with no prior treatment has prostate cancer.", undefined],
  ["Patient without symptoms has prostate cancer.", undefined],
  ["No bone metastases.", "negated"],
  ["No new bone metastases.", "negated"],
  ["Ohne Knochenmetastasen.", "negated"],
  ["Bone metastases were not ruled out.", "suspected"],
  ["Bone metastases can not be excluded.", "suspected"],
  ["Knochenmetastasen nicht sicher ausgeschlossen.", "suspected"],
  ["We cannot rule out bone metastases.", "suspected"],
  ["Bone metastases were not confirmed.", undefined],
  ["Knochenmetastasen nicht bestätigt.", undefined],
  ["Bone metastases were confirmed.", "asserted"],
  ["Bone metastases were ruled out.", "negated"],
  ["Pathology excluded bone metastases.", "negated"],
  ["Biopsy requested to rule out bone metastases.", undefined],
  ["Pathology has not ruled out bone metastases.", undefined],
  // A cue after a negation that no cue lists says nothing, not the opposite.
  ["Bone metastases could not be ruled out.", undefined],
  ["Bone metastases can't be ruled out.", undefined],
  ["Bone metastases cannot be completely excluded.", undefined],
  ["Bone metastases have not been confirmed.", undefined],
  // A confirmed suspicion is confirmed, though "suspected" stands nearer.
  ["The biopsy confirmed the suspected bone metastases.", "asserted"],
  ["MRI confirmed the suspicion of bone metastases.", "asserted"],
  ["The suspected bone metastases were confirmed by biopsy.", "asserted"],
  ["Suspicion of bone metastases was confirmed.", "asserted"],
  ["Verdacht auf Knochenmetastasen wurde bestätigt.", "asserted"],
  ["The suspected bone metastases were not confirmed.", "suspected"],
])("statusFromText(%j) = %j", (text, expected) => {
  expect(
    statusFromText(text, ["bone metastases", "Knochenmetastasen"])?.status,
  ).toBe(expected);
});

test("a German clause break ends a cue's reach", () => {
  expect(
    statusFromText("Kein Fieber, aber Knochenmetastasen", [
      "Knochenmetastasen",
    ]),
  ).toBeUndefined();
});

test("the default windows: up to 5 words between before, 3 after", () => {
  const names = ["bone metastases"];
  expect(
    statusFromText(
      "Suspected one two three four five six bone metastases",
      names,
    ),
  ).toBeUndefined();
  expect(
    statusFromText("Suspected one two three four five bone metastases", names)
      ?.status,
  ).toBe("suspected");
  expect(
    statusFromText("Bone metastases one two three ruled out", names)?.status,
  ).toBe("negated");
  expect(
    statusFromText("Bone metastases one two three four ruled out", names),
  ).toBeUndefined();
});

test("an attribute value that is an Object method is no status", () => {
  expect(statusFromAttribute("constructor")).toBeUndefined();
  expect(statusFromAttribute("toString")).toBeUndefined();
});
