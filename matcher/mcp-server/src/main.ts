import { text } from "node:stream/consumers";
import { createApproaches, createFusions } from "@matcher/approaches";
import { createDocumentStore, createPool } from "@matcher/db";
import { createDownloader } from "@matcher/download";
import { explain, explainSource } from "./explain.ts";
import { createMcpHttpServer } from "./http.ts";
import { createMatchService } from "./match.ts";

const port = Number(process.env.MCP_PORT ?? 3000);
// A search that runs longer is answered as degraded, instead of holding the database.
const SEARCH_TIMEOUT_MS = 10_000;
const pool = createPool(undefined, SEARCH_TIMEOUT_MS);
// The approaches come with all their dependencies; at query time the matchers only read the
// database, the downloader serves the indexers.
const approaches = createApproaches({
  db: pool,
  downloader: createDownloader(),
});
const service = createMatchService(
  [...approaches, ...createFusions(approaches)],
  createDocumentStore(pool),
);

const command = process.argv[2];
if (command === "explain" || command === "get_source") {
  // `node src/main.ts explain` answers the one `match_journey` request on stdin with the steps
  // of the match, `node src/main.ts get_source` the one `get_source` request; both without a
  // server. The debug UI runs them (debug/README.md).
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
  createMcpHttpServer(service).listen(port, "127.0.0.1", () => {
    console.log(`MCP server listening on http://127.0.0.1:${port}/mcp`);
  });
}
