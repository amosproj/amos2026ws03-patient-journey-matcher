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

// Many grades in few lines: per point and grade, the source_ids in one string.
const gradeListSchema = z.object({
  version: z.literal(1),
  points: z.record(
    z.string().min(1),
    z.object({
      as_of: z.iso.date(),
      grades: z.partialRecord(z.enum(["0", "1", "2", "3"]), z.string()),
    }),
  ),
});

/** What the metrics need of a judgment file. */
export type Graded = {
  points: { id: string; judgments: { source_id: string; grade: number }[] }[];
};

/** A file like judgments.json, or the short form of keyword-llm-judgments.json. */
export async function loadGrades(
  file: URL | string = judgmentsPath,
): Promise<Graded> {
  const json = JSON.parse(await readFile(file, "utf8"));
  if (Array.isArray(json?.points)) return judgmentFileSchema.parse(json);
  const { points } = gradeListSchema.parse(json);
  return {
    points: Object.entries(points).map(([id, { grades }]) => ({
      id,
      judgments: Object.entries(grades).flatMap(([grade, ids]) =>
        ids
          .split(" ")
          .filter(Boolean)
          .map((source_id) => ({ source_id, grade: Number(grade) })),
      ),
    })),
  };
}
