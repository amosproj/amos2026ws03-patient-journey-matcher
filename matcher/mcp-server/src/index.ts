import { createServer } from "node:http";
import { createPool } from "@matcher/db";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMatchService } from "./match.ts";
import { buildServer } from "./server.ts";

const port = Number(process.env.MCP_PORT ?? 3000);
const service = createMatchService(createPool());

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
const handleMcp = toNodeHandler(createMcpHandler(() => buildServer(service)));

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
