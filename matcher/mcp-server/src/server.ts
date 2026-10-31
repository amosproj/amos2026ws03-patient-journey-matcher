import { McpServer } from "@modelcontextprotocol/server";
import {
  getSourceInputSchema,
  type MatchJourneyInput,
  type MatchResult,
  matchJourneyInputSchema,
  matchResultSchema,
  type SourceContent,
  sourceContentSchema,
} from "./contract.ts";

export type ErrorCode =
  | "NOT_AVAILABLE"
  | "SOURCE_NOT_FOUND"
  | "UPSTREAM_UNAVAILABLE";

export class ToolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MatchService {
  matchJourney(request: MatchJourneyInput): Promise<MatchResult>;
  getSource(sourceId: string): Promise<SourceContent>;
}

async function toToolResult<Output extends Record<string, unknown>>(
  run: () => Promise<Output>,
) {
  try {
    const output = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const text = JSON.stringify({
      error_code: error.code,
      message: error.message,
    });
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

export function buildServer(service: MatchService): McpServer {
  const server = new McpServer({
    name: "patient-journey-matcher",
    version: "0.1.0",
  });

  server.registerTool(
    "match_journey",
    {
      title: "Match a patient journey",
      description:
        "Returns the sources most relevant to the most recent event of a patient journey.",
      inputSchema: matchJourneyInputSchema,
      outputSchema: matchResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (request) => toToolResult(() => service.matchJourney(request)),
  );

  server.registerTool(
    "get_source",
    {
      title: "Get a source",
      description:
        "Downloads one matched source again from its origin and returns its content without storing it.",
      inputSchema: getSourceInputSchema,
      outputSchema: sourceContentSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ source_id }) => toToolResult(() => service.getSource(source_id)),
  );

  return server;
}
