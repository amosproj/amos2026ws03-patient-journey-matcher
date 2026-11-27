# Matcher

The TypeScript side: MCP server, indexer job, transcription job and matching approaches, as one pnpm workspace. Packages and how they depend on each other: [code components](../Documentation/design/architecture.md#2-code-components); commands: [build](../Documentation/build-deploy/build.md#development); adding an approach: [matching approaches](algorithms/README.md).

## Dependencies

```text
mcp-server, indexer  →  approaches  →  algorithms/*  →  core, db, download, terminology
transcriber          →  db, download
evaluation           (no matcher package)
```

Programs reach the approaches only through `approaches` and the contracts in `core`; they also use `db` and `download` directly. Approaches import neither each other nor the programs; `core`, `db`, `download` and `terminology` import no other matcher package. A package can only import what its `package.json` lists.

## Rules

- **Files are named after their content** (`contracts.ts`, `downloader.ts`); programs start in `src/main.ts` (`evaluation`: `src/cli.ts`); `index.ts` only re-exports (`db`).
- **Factories get their dependencies:** `createX(dependencies)`; only `main.ts` creates the database pool and the downloader.
- **Tests sit next to the code** (`x.test.ts`); database tests use `createTestDatabase()`, skip without `TEST_DATABASE_URL` and must run on CI.
- **Checks:** `pnpm lint`, `pnpm typecheck` (strict, no unused code) and `pnpm test`; `make test` and CI run them.

## Semantic matching

From the repository root:

```sh
make index-ai   # build Qwen and BGE-M3 indexes; rerun after new crawls
make debug-ai   # start the encoder, MCP server and debug UI
```

These commands prepare dependencies, models and the database. The first index build can take time; interrupted builds resume. Open the printed URL and choose an encoder under Index › AI or a technique on the Matcher screen. Ctrl+C stops the services. `make start-ai` runs the encoder and MCP server alone.

Semantic matching uses titles, abstracts or descriptions and subjects, capped at 512 tokens. Results return the existing abstract or description. MCP uses `algorithm: "ai_summary"` with the server's configured encoder. Settings and defaults are in the root [`.env.example`](../.env.example).

With the encoder running and `TEST_DATABASE_URL` set, `SEMANTIC_SMOKE=1 pnpm exec vitest run mcp-server/src/semantic-live.test.ts` from `matcher/` checks real-model indexing on a small synthetic fixture.
