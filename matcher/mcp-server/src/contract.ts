import { z } from "zod";

// Field names follow the timeline.json of the synthetic journey generator,
// so a generated journey can be sent as it is. Unknown fields are dropped.
export const journeyEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  date: z.iso.date(),
  specialist: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const patientJourneySchema = z.object({
  patient_id: z.string().min(1),
  as_of: z.iso.date().optional(),
  events: z.array(journeyEventSchema).min(1).max(500),
});

export const algorithmSchema = z.enum(["keyword", "graph", "ai_summary"]);

export const sourceTypeSchema = z.enum([
  "paper",
  "preprint",
  "video",
  "podcast",
]);

export const matchJourneyInputSchema = z.object({
  journey: patientJourneySchema,
  algorithm: algorithmSchema.default("keyword"),
  limit: z.number().int().min(1).max(50).default(10),
  source_types: z.array(sourceTypeSchema).min(1).optional(),
});

export const sourceReferenceSchema = z.object({
  source_id: z.string().min(1),
  title: z.string().min(1),
  source: z.string().min(1),
  source_type: sourceTypeSchema,
  url: z.url(),
  published_date: z.string().optional(),
  authors: z.array(z.string()).optional(),
  licence: z.string().optional(),
});

export const matchItemSchema = sourceReferenceSchema.extend({
  rank: z.number().int().min(1),
  score: z.number().min(0).max(1).optional(),
  matched_terms: z.array(z.string()).optional(),
  explanation: z.string().optional(),
});

export const matchResultSchema = z.object({
  algorithm: algorithmSchema,
  focus_event_id: z.string().min(1),
  results: z.array(matchItemSchema),
  degraded: z.boolean(),
  degraded_reason: z.string().optional(),
});

export const getSourceInputSchema = z.object({
  source_id: z.string().min(1),
});

export const sourceContentSchema = sourceReferenceSchema.extend({
  content: z.string(),
  content_kind: z.enum(["abstract", "full_text", "transcript"]),
  fetched_at: z.iso.datetime(),
});

export type MatchJourneyInput = z.output<typeof matchJourneyInputSchema>;
export type MatchResult = z.output<typeof matchResultSchema>;
export type SourceContent = z.output<typeof sourceContentSchema>;
