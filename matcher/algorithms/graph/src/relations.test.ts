import { expect, test } from "vitest";
import { mapPatientEdge, mapPubTatorRelation } from "./relations.ts";

test.each([
  [
    "HAS_DIAGNOSIS",
    "Patient",
    "Diagnosis",
    { kind: "fact", fact: "has_condition" },
  ],
  ["PRESCRIBED", "Patient", "Medication", { kind: "fact", fact: "receives" }],
  ["UNDERWENT", "Patient", "Procedure", { kind: "fact", fact: "receives" }],
  [
    "HAS_TREATMENT_PLAN",
    "Patient",
    "TreatmentPlan",
    { kind: "fact", fact: "receives", status: "planned" },
  ],
  [
    "HAS_PATHOLOGY",
    "Patient",
    "PathologyResult",
    { kind: "fact", fact: "has_finding" },
  ],
  ["RELATES_TO", "Patient", "LabTest", { kind: "fact", fact: "has_finding" }],
  [
    "RELATES_TO",
    "Patient",
    "TreatmentPlan",
    { kind: "fact", fact: "receives", status: "planned" },
  ],
  [
    "INDICATES",
    "LabTest",
    "Diagnosis",
    { kind: "relation", predicate: "indicates", flip: false },
  ],
  [
    "CONFIRMED_BY",
    "PathologyResult",
    "Diagnosis",
    { kind: "relation", predicate: "indicates", flip: false, confirms: true },
  ],
  // The schema of tools/patient-graph has it from the diagnosis too (15 of 26 edges in patientdata/).
  [
    "CONFIRMED_BY",
    "Diagnosis",
    "PathologyResult",
    {
      kind: "relation",
      predicate: "indicates",
      flip: true,
      about: "source",
      confirms: true,
    },
  ],
  [
    "SYMPTOM_OF",
    "Symptom",
    "Diagnosis",
    { kind: "relation", predicate: "indicates", flip: false },
  ],
  [
    "TREATED_BY",
    "Diagnosis",
    "Medication",
    { kind: "relation", predicate: "treats", flip: true, about: "source" },
  ],
  // Not in that schema, but the graph's LLM writes it from the drug too (Patient-10, Patient-12).
  [
    "TREATED_BY",
    "Medication",
    "Diagnosis",
    { kind: "relation", predicate: "treats", flip: false },
  ],
  [
    "TREATED_BY",
    "Procedure",
    "Diagnosis",
    { kind: "relation", predicate: "treats", flip: false },
  ],
  // The graph's LLM also writes HAS_LAB_TEST for HAD_LAB_TEST (Patient-15).
  ["HAS_LAB_TEST", "Patient", "LabTest", { kind: "fact", fact: "has_finding" }],
  [
    "MANAGED_AT",
    "Patient",
    "Provider",
    { kind: "drop", reason: "administrative" },
  ],
  [
    "PERFORMED_BY",
    "Procedure",
    "Provider",
    { kind: "drop", reason: "administrative" },
  ],
  [
    "HAS_VITAL_SIGNS",
    "Patient",
    "VitalSigns",
    { kind: "drop", reason: "vital signs" },
  ],
])("patient %s %s → %s", (type, subject, object, expected) => {
  expect(mapPatientEdge(type, subject, object)).toEqual(expected);
});

test("RELATES_TO between two findings is only related, never a treatment", () => {
  expect(mapPatientEdge("RELATES_TO", "Procedure", "Diagnosis")).toEqual({
    kind: "relation",
    predicate: "related",
    flip: false,
  });
});

test("an unknown edge type is related between findings and dropped from the patient", () => {
  expect(mapPatientEdge("NEW_TYPE", "LabTest", "Diagnosis")).toMatchObject({
    predicate: "related",
  });
  expect(mapPatientEdge("NEW_TYPE", "Patient", "Diagnosis")).toEqual({
    kind: "drop",
    reason: "no row for this patient edge",
  });
});

test.each([
  ["Negative_Correlation", "Chemical", "Disease", "treats", false],
  ["Negative_Correlation", "Disease", "Chemical", "treats", true],
  ["Positive_Correlation", "Chemical", "Disease", "causes", false],
  ["Negative_Correlation", "Chemical", "Gene", "negative_correlation", false],
  ["Association", "Disease", "Gene", "associated_with", false],
  ["Cotreatment", "Chemical", "Chemical", "cotreated_with", false],
  ["Comparison", "Chemical", "Chemical", "compared_with", false],
  ["Bind", "Chemical", "Gene", "interacts_with", false],
  ["Something_New", "Chemical", "Disease", "related", false],
])("PubTator3 %s %s → %s", (type, subject, object, predicate, flip) => {
  expect(mapPubTatorRelation(type, subject, object)).toEqual({
    kind: "relation",
    predicate,
    flip,
  });
});
