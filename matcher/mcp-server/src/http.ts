import { createServer, type Server } from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServer, type MatchService } from "./server.ts";

/** Shared production and integration route; callers own listening and shutdown. */
export function createMcpHttpServer(service: MatchService): Server {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const handle = toNodeHandler(createMcpHandler(() => buildServer(service)));
  return createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    void Promise.resolve()
      .then(() => handle(req, res))
      .catch(() => {
        console.error("MCP transport request failed");
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      });
  });
}
