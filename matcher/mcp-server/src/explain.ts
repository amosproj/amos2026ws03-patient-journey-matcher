import { z } from "zod";
import {
  getSourceInputSchema,
  type MatchResult,
  matchJourneyInputSchema,
  type SourceDownloads,
} from "./contract.ts";
import { type MatchService, ToolError } from "./server.ts";

// The arguments of `match_journey`, plus other values for the matcher's ranking constants.
const explainInputSchema = matchJourneyInputSchema.extend({
  tuning: z.record(z.string(), z.number()).optional(),
});

export interface Explanation {
  /** What `match_journey` answers; left out if it refuses the request. */
  answer?: MatchResult;
  /** Why the request was refused: `INVALID_REQUEST` or the code of a tool error. */
  error?: { code: string; message: string };
  /** What the match worked out on the way, in order: `journey`, then the matcher's steps. */
  steps: { step: string; data: unknown }[];
}

/**
 * `match_journey` for one request, with the steps of the match. For the debug UI, which shows
 * synthetic journeys: the steps hold the terms of the journey.
 */
export async function explain(
  service: MatchService,
  input: unknown,
): Promise<Explanation> {
  const steps: Explanation["steps"] = [];
  const request = explainInputSchema.safeParse(input);
  if (!request.success) {
    const message = z.prettifyError(request.error);
    return { error: { code: "INVALID_REQUEST", message }, steps };
  }
  const { tuning, ...match } = request.data;
  try {
    const answer = await service.matchJourney(match, {
      tuning,
      trace: (step, data) => steps.push({ step, data }),
    });
    return { answer, steps };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { error: { code: error.code, message: error.message }, steps };
  }
}

/** `get_source` for one request, answered like `explain`. For the example client of the debug UI. */
export async function explainSource(
  service: MatchService,
  input: unknown,
): Promise<{ answer?: SourceDownloads; error?: Explanation["error"] }> {
  const request = getSourceInputSchema.safeParse(input);
  if (!request.success) {
    const message = z.prettifyError(request.error);
    return { error: { code: "INVALID_REQUEST", message } };
  }
  try {
    return { answer: await service.getSource(request.data.source_id) };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { error: { code: error.code, message: error.message } };
  }
}
