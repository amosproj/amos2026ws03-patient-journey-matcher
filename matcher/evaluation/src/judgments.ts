import { readFile } from "node:fs/promises";
import { z } from "zod";

// One evaluation point is a journey cut at as_of, like the app would send it
// when a new report arrives. Grades follow the scale in judgments.json.
export const evaluationPointSchema = z.object({
  id: z.string().min(1),
  journey: z.string().min(1),
  pathway_id: z.string().optional(),
  as_of: z.iso.date(),
  focus_event_id: z.string().min(1),
  focus: z.string().min(1),
  context: z.array(z.object({ event_id: z.string(), why: z.string() })),
  judgments: z.array(
    z.object({
      source_id: z.string().min(1),
      title: z.string().optional(),
      grade: z.number().int().min(0).max(3),
      note: z.string().optional(),
    }),
  ),
  reviewed_by: z.array(z.string()),
});

export const judgmentFileSchema = z.object({
  version: z.literal(1),
  points: z.array(evaluationPointSchema).min(1),
});

export type JudgmentFile = z.output<typeof judgmentFileSchema>;

export const judgmentsPath = new URL("../judgments.json", import.meta.url);

export async function loadJudgments(file: URL | string = judgmentsPath) {
  return judgmentFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
