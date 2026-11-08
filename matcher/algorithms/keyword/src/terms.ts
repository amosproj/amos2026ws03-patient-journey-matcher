import type { JourneyEvent } from "@matcher/core";

// German words of the synthetic journeys (#14) and the English terms the sources use. Words
// not listed pass through: drug names and abbreviations match as they are, other German
// words match nothing.
const ENGLISH: Record<string, string> = {
  abirateron: "abiraterone",
  adjuvante: "adjuvant",
  adjuvanter: "adjuvant",
  aktive: "active",
  alkalische: "alkaline",
  // Abbreviations of the journeys; "as" would otherwise be dropped as an English stop word.
  as: "active surveillance",
  androgendeprivationstherapie: "androgen deprivation therapy",
  anstieg: "rise",
  aufklärungsgespräch: "counseling",
  aufnahme: "admission",
  becken: "pelvic",
  bestimmung: "measurement",
  bestrahlung: "radiotherapy",
  bicalutamid: "bicalutamide",
  biochemisches: "biochemical",
  blutbild: "blood count",
  chemotherapie: "chemotherapy",
  einleitung: "initiation",
  entlassung: "discharge",
  entscheidung: "decision",
  enzalutamid: "enzalutamide",
  erhöht: "elevated",
  erhöhtem: "elevated",
  erhöhter: "elevated",
  erstbefund: "initial",
  erstvorstellung: "initial",
  externe: "external beam",
  fernmetastasen: "distant metastases",
  fernmetastasennachweis: "distant metastases",
  fokale: "focal",
  fusionierte: "fusion",
  ganzkörper: "whole body",
  genetik: "genetics",
  genetische: "genetic",
  gewebematerial: "tissue",
  gewichtsverlust: "weight loss",
  gezielte: "targeted",
  histopathologische: "histopathology",
  hochgradiger: "high grade",
  hochrisiko: "high risk",
  humangenetik: "genetics",
  kastrationsresistentes: "castration resistant",
  kastrationsresistenz: "castration resistant",
  keimbahn: "germline",
  knochendichte: "bone density",
  knochenmetastasen: "bone metastases",
  knochenschmerzen: "bone pain",
  knochenszintigraphie: "bone scan",
  konsil: "consultation",
  kontrolle: "monitoring",
  kurative: "curative",
  kurzzeitige: "short term",
  leber: "liver",
  leberwerte: "liver function",
  leitlinie: "guideline",
  leuprorelin: "leuprolide",
  lokalrezidiv: "local recurrence",
  lymphknoten: "lymph node",
  lymphknotenbefall: "lymph node metastases",
  läsion: "lesion",
  mets: "metastases",
  metastasiertes: "metastatic",
  miktionsbeschwerden: "urinary symptoms",
  molekulardiagnostik: "molecular testing",
  mrt: "mri",
  multiparametrisch: "multiparametric",
  multiparametrische: "multiparametric",
  mutiertes: "mutated",
  nachsorge: "follow up",
  nachweis: "detection",
  niedrigrisiko: "low risk",
  notfallvorstellung: "emergency",
  nuklearmedizin: "nuclear medicine",
  nykturie: "nocturia",
  onkologie: "oncology",
  operationspräparats: "surgical specimen",
  palliativmedizinischer: "palliative care",
  palliativmedizinisches: "palliative care",
  palliativversorgung: "palliative care",
  pathologie: "pathology",
  pathologische: "pathology",
  prednison: "prednisone",
  primäre: "primary",
  progress: "progression",
  progressives: "progressive",
  prophylaxe: "prophylaxis",
  prostata: "prostate",
  prostatakarzinom: "prostate cancer",
  prostataloge: "prostate bed",
  prostatektomie: "prostatectomy",
  radikale: "radical",
  radikalen: "radical",
  radikaler: "radical",
  radiologie: "radiology",
  radiotherapie: "radiotherapy",
  rarp: "robot assisted radical prostatectomy",
  rezidiv: "recurrence",
  rezidivlokalisation: "recurrence",
  rippen: "rib",
  roboterassistierte: "robot assisted",
  rpe: "radical prostatectomy",
  rt: "radiotherapy",
  samenblasen: "seminal vesicle",
  schmerzen: "pain",
  schmerztherapie: "pain management",
  somatische: "somatic",
  stanzbiopsie: "biopsy",
  stationäre: "inpatient",
  strahlentherapie: "radiotherapy",
  studie: "trial",
  symptomatische: "symptomatic",
  szintigraphie: "scintigraphy",
  testosteron: "testosterone",
  testung: "testing",
  therapie: "therapy",
  therapieentscheidung: "treatment decision",
  thorax: "chest",
  transrektale: "transrectal",
  tumorkonferenz: "tumor board",
  untersuchung: "examination",
  urologie: "urology",
  urologische: "urology",
  urologischen: "urology",
  verdacht: "suspected",
  verlaufskontrolle: "follow up",
  vorsorgeuntersuchung: "screening",
  wechsel: "switch",
  wirbelsäule: "spine",
  zweitlinie: "second line",
  zweitlinien: "second line",
  zyklen: "cycle",
  zyklus: "cycle",
  überwachung: "surveillance",
  überweisung: "referral",
};

// German function words and units; some would match English or German records by chance.
const SKIP = new Set(
  "als auf bei beim d da der des durch für ggf gy in kbq kein keine kg m mg ml nach ng re trotz und unter vom von wegen x zum zur".split(
    " ",
  ),
);

/** The English search terms of an event: its label, text parameters and the names of true flags. */
export function eventTerms(
  event: Pick<JourneyEvent, "label" | "parameters">,
): string[] {
  const texts = [event.label];
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    if (value === true) texts.push(key);
    for (const item of [value].flat()) {
      if (typeof item === "string") texts.push(item);
    }
  }
  const words =
    texts
      .join(" ")
      .replaceAll("_", " ")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words
    .filter((word) => /\p{L}/u.test(word) && !SKIP.has(word))
    .map((word) => ENGLISH[word] ?? word);
  return [...new Set(terms)];
}
