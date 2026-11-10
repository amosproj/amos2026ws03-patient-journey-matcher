import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { createApproaches } from "@matcher/approaches";
import { createDocumentStore, createPool } from "@matcher/db";
import { createDownloader } from "@matcher/download";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { explain } from "./explain.ts";
import { createMatchService } from "./match.ts";
import { buildServer } from "./server.ts";

const port = Number(process.env.MCP_PORT ?? 3000);
const pool = createPool();
// The approaches come with all their dependencies; at query time the matchers only read the
// database, the downloader serves the indexers.
const service = createMatchService(
  createApproaches({ db: pool, downloader: createDownloader() }),
  createDocumentStore(pool),
);

if (process.argv[2] === "explain") {
  // `node src/main.ts explain`: answers the one request on stdin with the steps of the match,
  // without a server. The debug UI runs it (debug/crawler/README.md).
  try {
    const request: unknown = JSON.parse(await text(process.stdin));
    console.log(JSON.stringify(await explain(service, request)));
  } finally {
    await pool.end();
  }
} else {
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
}
