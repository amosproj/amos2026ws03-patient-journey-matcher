import type { JourneyEvent } from "@matcher/core";
import { normalizeName } from "@matcher/terminology";
import timeline from "../data/timeline.json" with { type: "json" };
import {
  CERTAINTY,
  type ClinicalEvidence,
  type ClinicalLink,
  type DatedStatus,
  diagnosisRole,
  isLocalTherapy,
  isTherapy,
  latest,
  type Reading,
  roleOf,
  STATUS_ORDER,
} from "./reading.ts";
import {
  broaderDiagnosis,
  type Concept,
  compatibleDiagnoses,
  conceptOf,
  resolveIcd,
  type Terminology,
} from "./resolve.ts";
import {
  conceptStages,
  isCancer,
  isGenericNeoplasm,
  isNeoplasm,
  STAGE_CONCEPTS,
  type StageObservation,
  stageObservations,
} from "./stages.ts";
import {
  diseaseMentions,
  patientText,
  statusFromAttribute,
  statusFromText,
  treatmentClauses,
  treatmentStatus,
} from "./status.ts";
import { clip } from "./text.ts";
import type { Status } from "./types.ts";

function timelineTreatments(event: JourneyEvent, terminology: Terminology) {
  const courses = new Map<string, Status>();
  const clauses = treatmentClauses(event.label);
  const therapies = (text: string) =>
    terminology
      .findConcepts(text)
      .filter((concept) => isTherapy(roleOf(concept, undefined)));
  const attribute = event.parameters?.treatment_status;
  const type = normalizeName(event.type);
  const fallback =
    (typeof attribute === "string" ? treatmentStatus(attribute) : undefined) ??
    statusFromAttribute(attribute) ??
    (PLANS.has(type) ? "planned" : GIVES.has(type) ? "asserted" : "unknown");
  let namedAction = false;
  for (const clause of clauses) {
    for (const concept of therapies(clause.text)) {
      const cue = statusFromText(clause.text, [
        concept.name,
        ...concept.names,
      ])?.status;
      const status =
        cue === "negated" || cue === "suspected" ? cue : clause.status;
      if (status) namedAction = true;
      if (status || !courses.has(concept.id))
        courses.set(concept.id, status ?? fallback);
    }
  }
  const actions = new Set(clauses.flatMap((clause) => clause.status ?? []));
  const unnamed =
    !namedAction && actions.size === 1 ? [...actions][0] : undefined;
  for (const concept of therapies(eventText(event))) {
    if (!courses.has(concept.id)) courses.set(concept.id, unnamed ?? fallback);
  }
  return courses;
}

/** A code of a secondary neoplasm, such as C78.7 for liver metastases. */
function isSpread(code: unknown): boolean {
  return typeof code === "string" && /^\s*C7[7-9](?![0-9])/i.test(code);
}

function timelineConditions(
  events: JourneyEvent[],
  terminology: Terminology,
  evidence: ClinicalEvidence[],
  courses: Map<JourneyEvent, Map<string, Status>>,
) {
  type Statement = DatedStatus & { entity: string; ref: string };
  const since = new Map<string, string>();
  const notes: {
    event: JourneyEvent;
    text: string;
    statuses: Map<string, Status>;
    introduced: Set<string>;
    confirms: boolean;
  }[] = [];
  const conflicts = new Set<JourneyEvent>();
  for (const event of events) {
    const { diagnosis, icd_code: code, indication } = event.parameters ?? {};
    const diagnostic = ["diagnosis", "pathology", "progression"].includes(
      normalizeName(event.type),
    );
    const label = diseaseMentions(event.label, terminology);
    const field =
      typeof diagnosis === "string"
        ? diseaseMentions(diagnosis, terminology)
        : [];
    const byCode = resolveIcd(code);
    const labelHits = diagnostic || byCode?.type === "disease" ? label : [];
    // A code of a metastasis (C77 to C79, liver metastases C78.7) says where a cancer has spread,
    // not which cancer it is: it contradicts no name or code of the primary.
    const codes = [...field, ...labelHits]
      .filter((hit) => hit.code && !isSpread(hit.code))
      .map((hit) => hit.concept);
    const ownCode = isSpread(code) ? undefined : byCode;
    const codeConflict =
      ownCode && codes.some((item) => !compatibleDiagnoses(ownCode, item));
    if (ownCode?.type === "disease") codes.push(ownCode);
    // A name contradicts a code when both name a cancer and neither is a form of the other (breast
    // cancer and C34). A general word such as "Adenokarzinom" says the kind of tumour, which fits
    // any cancer code, and a complication or a further disease beside the coded one is no
    // contradiction (diabetic foot beside E11.74, atrial fibrillation beside I50.14).
    const nameConflict = [field, labelHits].some((hits) => {
      const names = hits.filter((hit) => !hit.code && isCancer(hit.concept.id));
      const positive = names.filter((hit) => hit.status !== "negated");
      const diagnosticNames = positive.length ? positive : names;
      return (
        diagnosticNames.length > 0 &&
        codes.some(
          (id) =>
            isCancer(id.id) &&
            !diagnosticNames.some((hit) =>
              compatibleDiagnoses(id, hit.concept),
            ),
        )
      );
    });
    if (codeConflict || nameConflict) {
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: "Diagnostic name and ICD code disagree",
      });
      conflicts.add(event);
      continue;
    }
    // Once the journey names a cancer, a progression or pathology report that names something
    // else in its label alone reports a finding, such as a pulmonary nodule or ascites, not a
    // new disease.
    const findingsOnly =
      ["progression", "pathology"].includes(normalizeName(event.type)) &&
      [...since.keys()].some(isCancer);
    const labelDiagnoses = findingsOnly
      ? label.filter((hit) => isNeoplasm(hit.concept.id))
      : label;
    const introduced = new Set<string>();
    for (const hit of [
      ...(field.length ? field : diagnostic ? labelDiagnoses : []),
      ...label.filter((hit) => hit.status === "negated"),
    ])
      introduced.add(hit.concept.id);
    if (byCode?.type === "disease") introduced.add(byCode.id);
    // A pathology report that names only the kind of tumour ("Adenokarzinom") confirms the one
    // specific cancer the journey has named so far.
    if (
      normalizeName(event.type) === "pathology" &&
      introduced.size &&
      [...introduced].every(isGenericNeoplasm)
    ) {
      const cancers = [...since.keys()].filter(isCancer);
      if (cancers.length === 1) introduced.add(cancers[0]);
    }
    // While the journey names no diagnosis, a suspicion written in any text of another event
    // ("Verdacht auf Bronchialkarzinom" in a CT finding) makes the diagnosis suspected, as a
    // diagnosis event would. Later, such a suspicion is a side finding (pneumonia on a CT). A
    // general heading such as carcinoma is no diagnosis of its own.
    const named = [...since.keys()].some((id) => !isGenericNeoplasm(id));
    const suspicions =
      diagnostic || diagnosis || code || named
        ? []
        : diseaseMentions(eventText(event), terminology).filter(
            (hit) =>
              hit.status === "suspected" &&
              !hit.code &&
              !isGenericNeoplasm(hit.concept.id),
          );
    for (const hit of suspicions) introduced.add(hit.concept.id);
    if (
      typeof indication === "string" &&
      [...(courses.get(event)?.values() ?? [])].includes("asserted")
    ) {
      const targets = new Set(
        terminology.findDiseases(indication).map((hit) => hit.concept.id),
      );
      const [target] = targets;
      if (targets.size === 1 && !since.has(target)) introduced.add(target);
    }
    if (!introduced.size && (diagnostic || diagnosis || code))
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: "No unambiguous mapped diagnosis in diagnostic field",
      });
    for (const id of introduced) if (!since.has(id)) since.set(id, event.date);
    const statuses = new Map<string, Status>();
    for (const hit of [...field, ...label, ...suspicions]) {
      const prior = statuses.get(hit.concept.id) ?? "unknown";
      if (hit.status && STATUS_ORDER[hit.status] > STATUS_ORDER[prior])
        statuses.set(hit.concept.id, hit.status);
    }
    notes.push({
      event,
      introduced,
      statuses,
      // A pathology report states the diagnoses it names as findings.
      confirms: normalizeName(event.type) === "pathology",
      text: [
        diagnosis,
        event.label,
        code,
        indication,
        ...(suspicions.length ? [eventText(event)] : []),
      ]
        .filter(Boolean)
        .join(". "),
    });
  }
  const statements: Statement[] = [];
  for (const { event, introduced, statuses, confirms, text } of notes) {
    for (const entity of new Set([...introduced, ...statuses.keys()])) {
      const start = since.get(entity);
      if (!start || event.date < start) continue;
      statements.push({
        entity,
        validAt: event.date,
        ref: event.id,
        text,
        status:
          statuses.get(entity) ??
          statusFromAttribute(event.parameters?.diagnosis_status) ??
          (confirms && introduced.has(entity) ? "asserted" : "unknown"),
      });
    }
  }
  return { statements, conflicts };
}

/** The text of an event that names concepts: its label and its text parameters. */
function eventText(event: JourneyEvent): string {
  const {
    participants: _departments,
    family_history: _relatives,
    ...parameters
  } = event.parameters ?? {};
  const values = Object.values(parameters).flatMap((value) =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [],
  );
  return clip([event.label, ...values].join(". "));
}

/** The event with its label and text parameters as the reader takes them, see `clip`. */
function clipped(event: JourneyEvent): JourneyEvent {
  if (!event.parameters) return { ...event, label: clip(event.label) };
  const parameters = Object.entries(event.parameters).map(([key, value]) => [
    key,
    typeof value === "string" ? clip(value) : value,
  ]);
  return {
    ...event,
    label: clip(event.label),
    parameters: Object.fromEntries(parameters),
  };
}

/** Only explicitly paired fields describe what the intervention or finding refers to. */
function* timelineRelations(
  event: JourneyEvent,
  text: string,
  courses: Map<string, Status>,
  terminology: Terminology,
  evidence: ClinicalEvidence[],
): Generator<ClinicalLink> {
  for (const [field, predicate, keys] of [
    ["indication", "treats", ["drug", "medication", "procedure"]],
    ["indicates", "indicates", ["finding", "test"]],
  ] as const) {
    const target = event.parameters?.[field];
    if (typeof target !== "string") continue;
    const targets = [
      ...new Set(terminology.findDiseases(target).map((hit) => hit.concept.id)),
    ];
    if (targets.length !== 1) {
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: `No single mapped diagnosis for ${field}`,
      });
      continue;
    }
    let resolved = false;
    for (const key of keys) {
      const value = event.parameters?.[key];
      if (typeof value !== "string") continue;
      for (const subject of terminology.findConcepts(value)) {
        const role = roleOf(subject, undefined);
        if (predicate === "treats" ? !isTherapy(role) : isTherapy(role))
          continue;
        const status =
          predicate === "treats"
            ? courses.get(subject.id)
            : (statusFromText(text, [subject.name, ...subject.names])?.status ??
              "asserted");
        if (
          !status ||
          (predicate === "treats" &&
            (status === "unknown" || status === "suspected"))
        )
          continue;
        resolved = true;
        yield {
          subject: subject.id,
          predicate,
          object: targets[0],
          ref: event.id,
          validAt: event.date,
          status,
        };
      }
    }
    if (!resolved)
      evidence.push({
        ref: event.id,
        date: event.date,
        diagnosis: targets[0],
        detail:
          predicate === "treats"
            ? "Indication lacks a mapped, dated intervention"
            : "Diagnosis lacks a mapped finding",
      });
  }
}

type Implied = { id: string; status: Status };
type ParameterRule = {
  concepts?: string[];
  values?: Record<string, string[]>;
  implies?: Record<string, string>;
  atLeast?: number;
  events?: string[];
};
const PLANS = new Set(timeline.plans.map(normalizeName));
const GIVES = new Set(timeline.gives.map(normalizeName));
const PARAMETERS: Record<string, ParameterRule> = timeline.parameters;

/** What the parameters of an event say: concepts, and diagnoses they assert or make suspected. */
function parameterFacts(event: JourneyEvent): {
  concepts: Concept[];
  implied: Implied[];
} {
  const concepts: Concept[] = [];
  const implied: Implied[] = [];
  const type = normalizeName(event.type);
  // A measured PSA is a search concept even below the diagnostic threshold. The
  // synthetic journeys also copy PSA onto unrelated events, such as admissions.
  const psa = event.parameters?.psa_value;
  if (
    (type === "lab test" || type === "followup") &&
    typeof psa === "number" &&
    Number.isFinite(psa) &&
    psa >= 0
  ) {
    const marker = conceptOf("ncbigene:354");
    if (marker) concepts.push(marker);
  }
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    const rule = PARAMETERS[key];
    if (rule === undefined || value === null || value === undefined) continue;
    if (rule.events && !rule.events.map(normalizeName).includes(type)) continue;
    if (
      rule.atLeast !== undefined &&
      ((typeof value !== "number" && typeof value !== "string") ||
        !Number.isFinite(Number(value)) ||
        Number(value) < rule.atLeast)
    )
      continue;
    const ids = [
      ...(rule.concepts ?? []),
      ...(rule.values?.[String(value)] ?? []),
    ];
    for (const id of ids) {
      const concept = conceptOf(id);
      if (concept !== undefined) concepts.push(concept);
    }
    for (const [id, status] of Object.entries(rule.implies ?? {}))
      implied.push({ id, status: status as Status });
  }
  return { concepts, implied };
}

/** Reads a timeline: the diagnoses, therapies and findings of its events up to the cutoff. */
export function readTimeline(context: JourneyEvent[], reading: Reading): void {
  const {
    focus,
    weights,
    terminology,
    cutoff,
    conceptOf,
    factor,
    multiplier,
    recordHistology,
    evidence,
    links,
    diagnoses,
    excluded,
    diagnosisDates,
    observed,
    therapy,
    found,
  } = reading;
  const events = [...context, focus]
    .map(clipped)
    .flatMap((event) => {
      if (event.date > cutoff) return [];
      const label = patientText(event.label);
      const familyEvent = normalizeName(event.type) === "family history";
      if (
        !familyEvent &&
        label === event.label &&
        eventText(event) === patientText(eventText(event))
      )
        return [event];
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: "Family history excluded",
      });
      if (familyEvent) return [];
      const originalIds = new Set(
        terminology.findDiseases(event.label).map((hit) => hit.concept.id),
      );
      const patientIds = new Set(
        terminology.findDiseases(label).map((hit) => hit.concept.id),
      );
      const parameters = Object.fromEntries(
        Object.entries(event.parameters ?? {}).flatMap(([key, value]) => {
          if (typeof value !== "string") return [[key, value]];
          const cleaned = patientText(value);
          if (!cleaned) return [];
          if (
            label !== event.label &&
            ["diagnosis", "icd_code"].includes(key)
          ) {
            const hits = terminology.findDiseases(cleaned);
            if (
              hits.some(
                ({ concept }) =>
                  originalIds.has(concept.id) && !patientIds.has(concept.id),
              )
            )
              return [];
          }
          return [[key, cleaned]];
        }),
      );
      if (!label && !parameters.diagnosis && !parameters.icd_code) return [];
      return [{ ...event, label, parameters }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const courses = new Map(
    events.map((event) => [event, timelineTreatments(event, terminology)]),
  );
  const { statements: conditions, conflicts } = timelineConditions(
    events,
    terminology,
    evidence,
    courses,
  );
  reading.diagnosticHistory = conditions;
  const staging: (StageObservation & { validAt: string })[] = [];
  const recordStage = (id: string, status: Status, validAt: string) => {
    for (const stage of conceptStages(id))
      staging.push({ stage, entity: id, status, validAt });
  };
  for (const fact of latest(conditions, (fact) => fact.entity, cutoff)) {
    diagnosisDates.set(fact.entity, fact.validAt);
    evidence.push({
      ref: fact.ref,
      date: fact.validAt,
      diagnosis: fact.entity,
      status: fact.status,
      detail: "Dated diagnostic statement",
    });
    const concept = conceptOf(fact.entity);
    if (concept === undefined) continue;
    const role = diagnosisRole(concept, fact.text ?? "");
    if (role === "stage") recordStage(concept.id, fact.status, fact.validAt);
    if (fact.status === "negated" || fact.status === "planned") {
      excluded.add(fact.entity);
      continue;
    }
    const weight = weights.roles[role] * factor(fact.validAt, fact.status);
    if (role === "diagnosis" || broaderDiagnosis(concept.id) !== undefined)
      diagnoses.set(concept.id, weight);
    if (fact.status === "asserted" && diagnoses.has(concept.id))
      therapy.diagnosed = true;
    found.push({
      concept,
      role,
      weight,
      focus: fact.validAt === focus.date,
      status: fact.status,
    });
  }
  const cancellations = new Map<
    JourneyEvent,
    { subjects: Set<string>; indication?: string }
  >();
  const indicationOf = (event: JourneyEvent) => {
    const name = event.parameters?.indication;
    if (typeof name !== "string") return undefined;
    const ids = new Set(
      terminology.findDiseases(name).map((hit) => hit.concept.id),
    );
    return ids.size === 1 ? [...ids][0] : normalizeName(name);
  };
  // Per event: the concepts its texts name and its parameters give, whether it plans or gives
  // the therapies among them, and the diagnoses it implies.
  const read = events
    .filter((event) => !conflicts.has(event))
    .map((event) => {
      const parameters = parameterFacts(event);
      const text = eventText(event);
      const p = event.parameters;
      const site = p?.diagnosis ?? p?.indication ?? p?.icd_code;
      recordHistology(
        event.label,
        event.date,
        event.id,
        typeof site === "string" ? site : undefined,
        p?.histology,
        statusFromAttribute(p?.diagnosis_status),
      );
      const treatments = courses.get(event) ?? new Map<string, Status>();
      const actions = [...treatments.values()];
      const onlyPlan =
        !actions.includes("asserted") &&
        (PLANS.has(normalizeName(event.type)) || actions.includes("planned"));
      // A plan is no evidence of the state it would lead to. Surveillance is the exception:
      // the decision for it puts the patient on it.
      for (const observation of stageObservations(text, terminology)) {
        if (!onlyPlan || observation.stage === "surveillance")
          staging.push({ ...observation, validAt: event.date });
      }
      if (!onlyPlan) {
        for (const concept of parameters.concepts)
          recordStage(concept.id, "asserted", event.date);
        for (const [key, value] of Object.entries(event.parameters ?? {}))
          if (value === false)
            for (const id of PARAMETERS[key]?.values?.true ?? [])
              recordStage(id, "negated", event.date);
      }
      const cancelled = [...treatments].filter(
        ([, status]) => status === "negated",
      );
      if (cancelled.length)
        cancellations.set(event, {
          subjects: new Set(cancelled.map(([id]) => id)),
          indication: indicationOf(event),
        });
      const concepts = [
        ...new Set([...terminology.findConcepts(text), ...parameters.concepts]),
      ].filter(
        (concept) =>
          !diagnoses.has(concept.id) &&
          (!excluded.has(concept.id) || STAGE_CONCEPTS.has(concept.id)) &&
          (isTherapy(roleOf(concept, undefined))
            ? treatments.get(concept.id) !== "negated"
            : statusFromText(text, [concept.name, ...concept.names])?.status !==
              "negated"),
      );
      const implied = [...parameters.implied];
      for (const concept of concepts)
        if (
          concept.implies !== undefined &&
          treatments.get(concept.id) === "asserted" &&
          (concept.id !== "mesh:D011468" ||
            /\bradical|\bradikal|\brpe\b|\brarp\b|\bralp\b/.test(
              normalizeName(text),
            ))
        )
          implied.push({ id: concept.implies, status: "asserted" });
      const prostateWorkup =
        parameters.implied.length > 0 ||
        treatments.get("mesh:D011468") === "asserted";
      return {
        event,
        text,
        concepts,
        treatments,
        implied,
        prostateWorkup,
      };
    });
  // A cancellation withdraws earlier plans for the named intervention. Past administrations
  // and plans made after the cancellation still contribute at their own cutoffs.
  for (const plan of read) {
    if (
      !cancellations.size ||
      ![...plan.treatments.values()].includes("planned")
    )
      continue;
    const indication = indicationOf(plan.event);
    for (const [event, cancel] of cancellations) {
      if (
        event.date < plan.event.date ||
        (cancel.indication && indication && cancel.indication !== indication)
      )
        continue;
      plan.concepts = plan.concepts.filter(
        (concept) =>
          plan.treatments.get(concept.id) !== "planned" ||
          !cancel.subjects.has(concept.id),
      );
    }
  }
  // An exclusion of distant spread (M0) applies to earlier sites; a site-specific
  // exclusion leaves evidence for other sites available.
  const activeStages = latest(
    staging,
    (item) => `${item.stage}/${item.entity ?? ""}`,
    cutoff,
    undefined,
    true,
  );
  const stageStatus = new Map<string, Status>();
  for (const item of activeStages) {
    const general = activeStages.find(
      (other) =>
        other.stage === item.stage &&
        (!other.entity || other.entity === "mesh:D009362") &&
        other.status === "negated" &&
        other.validAt >= item.validAt,
    );
    const status = general ? "negated" : item.status;
    if (item.entity) {
      stageStatus.set(item.entity, status);
      if (status === "negated" || status === "planned") {
        excluded.add(item.entity);
        diagnoses.delete(item.entity);
      } else excluded.delete(item.entity);
    }
    if (status === "asserted" || status === "unknown") observed.add(item.stage);
  }
  // A journey that does not name the diagnosis implies it: a Gleason grade, a prostatectomy or
  // a disease-specific treatment supports it, an elevated PSA or PI-RADS makes it suspected
  // (data/timeline.json, concepts.json `implies`). Another disease does not stand in for it.
  // Where the journey names it, or a form of it, the same evidence confirms it.
  const prostateWorkup = read.some((event) => event.prostateWorkup);
  const inferred = new Map<string, Status>();
  for (const { implied, event } of read)
    for (const { id, status } of implied) {
      if (excluded.has(id) || !prostateWorkup) continue;
      const named = [...diagnoses.keys()].some(
        (known) => known === id || broaderDiagnosis(known) === id,
      );
      if (named && (status !== "asserted" || therapy.diagnosed)) continue;
      if (!named && inferred.get(id) === "asserted") continue;
      if (named) {
        therapy.diagnosed = true;
        // The confirmation counts for the named diagnosis as a dated statement would.
        const weight = weights.roles.diagnosis * factor(event.date, status);
        for (const item of found)
          if (
            item.role === "diagnosis" &&
            (item.concept.id === id ||
              broaderDiagnosis(item.concept.id) === id) &&
            item.weight < weight
          ) {
            item.weight = weight;
            item.status = status;
            diagnoses.set(item.concept.id, weight);
          }
      } else inferred.set(id, status);
      evidence.push({
        ref: event.id,
        date: event.date,
        diagnosis: id,
        status,
        detail: named
          ? "Confirmed by a prostate workup"
          : "Inferred from a prostate workup",
      });
    }
  for (const [id, status] of inferred) {
    const concept = conceptOf(id);
    if (concept === undefined) continue;
    const weight = weights.roles.diagnosis * CERTAINTY[status];
    diagnoses.set(id, weight);
    if (status === "asserted") therapy.diagnosed = true;
    found.push({ concept, role: "diagnosis", weight, focus: false });
  }
  // The current therapy: the therapies of the latest event that gives one, or of the focus
  // event when it decides them.
  const lastTherapy = read.findLastIndex(({ concepts, treatments, event }) =>
    concepts.some(
      ({ id }) =>
        treatments.get(id) === "asserted" ||
        (event.id === focus.id && treatments.get(id) === "planned"),
    ),
  );
  read.forEach(({ event, text, concepts, treatments }, index) => {
    for (const relation of timelineRelations(
      event,
      text,
      treatments,
      terminology,
      evidence,
    )) {
      if (
        relation.status !== "planned" ||
        concepts.some((c) => c.id === relation.subject)
      )
        links.push(relation);
    }
    const news = event.id === focus.id;
    for (const concept of concepts) {
      const role = roleOf(concept, undefined);
      const course = treatments.get(concept.id);
      const received = course === "asserted";
      const planned = course === "planned";
      if (planned) therapy.plannedTherapy = true;
      if (received) {
        if (isLocalTherapy(concept, [concept.name]))
          therapy.localTherapy = true;
        if (
          normalizeName(event.type) === "surgery" &&
          concept.id === "mesh:D011468"
        )
          therapy.prostatectomy = true;
        if (role === "drug") therapy.systemicTherapy = true;
      }
      const current = index === lastTherapy && (received || planned);
      const status = planned
        ? "planned"
        : course === "suspected" || stageStatus.get(concept.id) === "suspected"
          ? "suspected"
          : "unknown";
      found.push({
        concept,
        role,
        weight:
          weights.roles[role] *
          CERTAINTY[status] *
          multiplier(news, current, false),
        focus: news || current,
        received,
      });
    }
  });
}
