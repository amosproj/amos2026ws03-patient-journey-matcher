import type { JourneyState } from "@matcher/core";
import { normalizePatientGraph, parseDay } from "./patient.ts";
import {
  CERTAINTY,
  diagnosisRole,
  isLocalTherapy,
  isTherapy,
  latest,
  type Reading,
  type Role,
  roleOf,
  tripleKey,
} from "./reading.ts";
import { broaderDiagnosis, type Concept } from "./resolve.ts";
import { STAGE_CONCEPTS } from "./stages.ts";
import { normalizeName } from "./text.ts";

/** Roles whose statements are new measurements each time, such as a PSA value. */
const MEASUREMENTS: ReadonlySet<Role> = new Set(["test", "gene", "finding"]);

const SYSTEMIC_THERAPY =
  /\badt\b|androgen|hormonther|hormone therap|leupro|gosere|degarel|relugol|bicalut|abirater|enzalut|apalut|darolut|docetax|cabazitax|olaparib|radium|chemother/;

/** Reads a patient graph: the statements that are valid at the cutoff. */
export function readGraph(
  graph: NonNullable<JourneyState["graph"]>,
  reading: Reading,
): void {
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
    stageIds,
    stageTexts,
    therapy,
    found,
  } = reading;
  // Future-only nodes must not contribute aliases or labels to a historical snapshot.
  const edges = graph.edges.filter(
    (edge) => edge.valid_at && edge.valid_at.slice(0, 10) <= cutoff,
  );
  const ends = new Set(
    edges.flatMap((edge) => [edge.source_node_uuid, edge.target_node_uuid]),
  );
  const activeNodes = graph.nodes
    .filter((node) => ends.has(node.uuid))
    .map((node) => {
      const attributes = node.attributes as
        | { icd_code?: unknown; date_confirmed?: unknown }
        | undefined;
      const confirmed = parseDay(attributes?.date_confirmed);
      if (!attributes?.icd_code || !confirmed || confirmed <= cutoff)
        return node;
      // Graphiti may attach the final diagnosis code to a node that already existed at referral.
      return { ...node, attributes: { ...attributes, icd_code: undefined } };
    });
  const secondarySites = new Set(
    activeNodes
      .filter((node) =>
        /^C7[789]\b/i.test(
          String(
            (node.attributes as { icd_code?: unknown } | undefined)?.icd_code ??
              "",
          ),
        ),
      )
      .map((node) => node.uuid),
  );
  const normalized = normalizePatientGraph(
    {
      nodes: activeNodes,
      edges,
    },
    { terminology },
  );
  const familyRefs = new Set(
    normalized.skipped
      .filter((s) => s.reason === "family history")
      .map((s) => s.ref),
  );
  reading.diagnosticHistory = normalized.facts
    .filter((fact) => fact.conditionRole === "diagnosis")
    .map((fact) => ({ ...fact, ref: fact.origin.ref }));
  for (const edge of edges) {
    if (edge.valid_at && familyRefs.has(edge.uuid))
      evidence.push({
        ref: edge.uuid,
        date: edge.valid_at.slice(0, 10),
        detail: "Family history excluded",
      });
  }
  const entities = new Map(
    normalized.entities.map((entity) => [entity.key, entity]),
  );
  // Since when an entity holds without a break: its earliest statement that is still valid at
  // the cutoff. Graphiti ends the earlier ones when something changes (a drug stopped, then
  // started again), so this is the start of the current episode.
  const firstSeen = new Map<string, string>();
  for (const fact of normalized.facts) {
    if (fact.validAt === undefined || fact.validAt > cutoff) continue;
    if (fact.invalidAt !== undefined && fact.invalidAt <= cutoff) continue;
    const known = firstSeen.get(fact.entity);
    if (known === undefined || fact.validAt < known)
      firstSeen.set(fact.entity, fact.validAt);
  }
  const items: {
    fact: (typeof normalized.facts)[number];
    concept: Concept;
    role: Role;
  }[] = [];
  const sentences = weights.sentences ? stageTexts : undefined;
  const activeFacts = latest(
    normalized.facts,
    (fact) => `${fact.conditionRole ?? fact.kind}:${fact.entity}`,
    cutoff,
    sentences,
  );
  const activeRelations = latest(
    normalized.relations,
    tripleKey,
    cutoff,
    sentences,
  );
  for (const fact of activeFacts) {
    const entity = entities.get(fact.entity);
    if (fact.conditionRole === "diagnosis")
      diagnosisDates.set(fact.entity, fact.validAt);
    if (
      fact.conditionRole === "diagnosis" &&
      (fact.status === "negated" || fact.status === "planned")
    )
      excluded.add(fact.entity);
    if (fact.conditionRole === "diagnosis")
      evidence.push({
        ref: fact.origin.ref,
        date: fact.validAt,
        diagnosis: entity?.id ?? undefined,
        status: fact.status,
        detail: entity?.id
          ? "Dated diagnostic statement"
          : "No unambiguous mapped diagnosis for node",
      });
    if (
      entity === undefined ||
      fact.status === "negated" ||
      (fact.conditionRole === "diagnosis" && fact.status === "planned")
    )
      continue;
    const names = entity.names.map(normalizeName);
    if (fact.status !== "planned" && fact.status !== "suspected")
      stageTexts.push(...names);
    if (
      fact.kind === "receives" &&
      (fact.status === "asserted" || fact.status === "unknown")
    ) {
      if (
        isLocalTherapy(
          entity.id === null ? undefined : conceptOf(entity.id),
          names,
        )
      )
        therapy.localTherapy = true;
      if (entity.id === "mesh:D011468") therapy.prostatectomy = true;
      if (
        entity.type === "chemical" ||
        names.some((name) => SYSTEMIC_THERAPY.test(name))
      )
        therapy.systemicTherapy = true;
    }
    if (
      fact.kind === "receives" &&
      fact.status === "planned" &&
      (entity.type === "chemical" || entity.type === "procedure")
    )
      therapy.plannedTherapy = true;
    // An unresolved entity counts with the curated concepts its names contain, such as
    // radiotherapy in "Strahlentherapie der Prostataloge".
    const known = entity.id === null ? undefined : conceptOf(entity.id);
    const concepts = known
      ? [known]
      : fact.conditionRole === "diagnosis"
        ? []
        : terminology.findConcepts(entity.names.join(". "));
    for (const concept of concepts) {
      const role =
        fact.conditionRole === "allergy"
          ? "finding"
          : known &&
              fact.conditionRole === "diagnosis" &&
              !entity.sources.some((id) => secondarySites.has(id))
            ? diagnosisRole(
                concept,
                [...entity.names, fact.text ?? ""].join(" "),
              )
            : roleOf(concept, fact.conditionRole);
      items.push({ fact, concept, role });
    }
  }
  // The current therapy: the therapies that started last, whatever edge states them (a
  // radiotherapy can come as RELATES_TO). A plan counts once it is news: decided that day.
  const begins = (fact: (typeof items)[number]["fact"]) =>
    fact.status !== "planned" || firstSeen.get(fact.entity) === focus.date;
  const started = items
    .filter(({ fact, role }) => isTherapy(role) && begins(fact))
    .map(({ fact }) => firstSeen.get(fact.entity) ?? "");
  // ISO dates sort as text.
  const latestStart = started.sort().at(-1) ?? "";
  for (const { fact, concept, role } of items) {
    const onFocusDay = fact.validAt === focus.date;
    const news = onFocusDay && firstSeen.get(fact.entity) === focus.date;
    const current =
      isTherapy(role) &&
      begins(fact) &&
      latestStart !== "" &&
      firstSeen.get(fact.entity) === latestStart;
    const measurement = onFocusDay && MEASUREMENTS.has(role);
    const weight =
      weights.roles[role] *
      CERTAINTY[fact.status] *
      multiplier(news, current, measurement);
    const narrower =
      fact.conditionRole === "diagnosis" &&
      broaderDiagnosis(concept.id) !== undefined;
    if (role === "diagnosis" || narrower) {
      diagnoses.set(
        concept.id,
        Math.max(weight, diagnoses.get(concept.id) ?? 0),
      );
      if (fact.status === "asserted") therapy.diagnosed = true;
    }
    found.push({
      concept,
      role,
      weight,
      focus: news || current || measurement,
      status: fact.status,
      received:
        fact.kind === "receives" &&
        fact.status !== "planned" &&
        fact.status !== "suspected",
    });
    // A plan is no evidence of the state it would imply (radium-223: castration-resistant).
    if (
      fact.status !== "planned" &&
      fact.status !== "suspected" &&
      concept.type !== "chemical" &&
      !(role === "diagnosis" && STAGE_CONCEPTS.has(concept.id))
    )
      stageIds.push(concept.id);
  }
  // At referral the only diagnosis evidence may be a test that indicates a diagnosis.
  // A later exclusion by the patient or pathology must still veto this weaker inference.
  for (const relation of activeRelations) {
    if (
      diagnoses.has(relation.object) ||
      relation.predicate !== "indicates" ||
      relation.status === "negated" ||
      relation.status === "planned"
    )
      continue;
    const source = entities.get(relation.subject);
    const finding = conceptOf(relation.subject);
    const measured = finding && MEASUREMENTS.has(roleOf(finding, undefined));
    if (
      !measured &&
      !source?.labels.some((label) =>
        ["LabTest", "TumorMarker", "ImagingResult", "PathologyResult"].includes(
          label,
        ),
      )
    )
      continue;
    const target = entities.get(relation.object);
    const concept = conceptOf(relation.object);
    if (
      activeFacts.some(
        (fact) =>
          fact.status === "negated" &&
          ((fact.entity === relation.object &&
            fact.conditionRole === "diagnosis") ||
            (fact.entity === relation.subject && fact.kind === "has_finding")),
      ) ||
      !target?.labels.includes("Diagnosis") ||
      concept?.type !== "disease" ||
      roleOf(concept, "diagnosis") !== "diagnosis"
    )
      continue;
    const weight =
      weights.roles.diagnosis * factor(relation.validAt, "suspected");
    diagnoses.set(concept.id, Math.max(weight, diagnoses.get(concept.id) ?? 0));
    found.push({
      concept,
      role: "diagnosis",
      weight,
      status: "suspected",
      focus: relation.validAt === focus.date,
    });
    if (measured) {
      const role = roleOf(finding, undefined);
      found.push({
        concept: finding,
        role,
        weight: weights.roles[role] * factor(relation.validAt, "unknown"),
        focus: relation.validAt === focus.date,
      });
    }
  }
  for (const relation of activeRelations) {
    // An unspecified relationship on both sides is no evidence that their meanings agree.
    if (relation.predicate === "related") continue;
    if (
      !entities.get(relation.subject)?.id ||
      !entities.get(relation.object)?.id
    ) {
      evidence.push({
        ref: relation.origin.ref,
        date: relation.validAt,
        detail: `Missing mapped endpoint for ${relation.predicate}`,
      });
      continue;
    }
    const subject = conceptOf(relation.subject);
    const incompatible =
      relation.predicate === "treats" &&
      (!subject || !isTherapy(roleOf(subject, undefined)));
    if (incompatible) continue;
    const blocked = activeFacts.some(
      (fact) =>
        fact.entity === relation.subject &&
        (fact.kind === "receives" || fact.kind === "has_finding") &&
        fact.status === "negated",
    );
    links.push({
      ...relation,
      validAt: relation.validAt,
      ref: relation.origin.ref,
      status: blocked ? "negated" : relation.status,
    });
  }
  for (const fact of [...normalized.facts, ...normalized.relations]) {
    if (
      !fact.text ||
      !fact.validAt ||
      (fact.invalidAt && fact.invalidAt <= cutoff)
    )
      continue;
    const site =
      "object" in fact
        ? fact.object
        : fact.conditionRole === "diagnosis"
          ? fact.entity
          : undefined;
    recordHistology(
      fact.text,
      fact.validAt,
      fact.origin.ref,
      site,
      undefined,
      fact.status,
    );
  }
}
