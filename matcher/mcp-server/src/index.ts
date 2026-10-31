import { createServer } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer, type MatchService, ToolError } from "./server.ts";

const port = Number(process.env.MCP_PORT ?? 3000);

// Replaced by the real matchers from #8, #9 and #10.
const notAvailable: MatchService = {
  matchJourney: async () => {
    throw new ToolError("NOT_AVAILABLE", "No matcher is available yet.");
  },
  getSource: async () => {
    throw new ToolError("NOT_AVAILABLE", "No source store is available yet.");
  },
};

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
const handleMcp = toNodeHandler(
  createMcpHandler(() => buildServer(notAvailable)),
);

// Loopback only, because the server has no authentication yet.
createServer((req, res) => {
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  void handleMcp(req, res);
}).listen(port, "127.0.0.1", () => {
  console.log(`MCP server listening on http://127.0.0.1:${port}/mcp`);
});
