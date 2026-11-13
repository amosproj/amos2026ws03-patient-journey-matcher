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
import { explain, explainSource } from "./explain.ts";
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

const command = process.argv[2];
if (command === "explain" || command === "get_source") {
  // `node src/main.ts explain` answers the one `match_journey` request on stdin with the steps
  // of the match, `node src/main.ts get_source` the one `get_source` request; both without a
  // server. The debug UI runs them (debug/crawler/README.md).
  try {
    const request: unknown = JSON.parse(await text(process.stdin));
    const answer =
      command === "explain"
        ? await explain(service, request)
        : await explainSource(service, request);
    console.log(JSON.stringify(answer));
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
