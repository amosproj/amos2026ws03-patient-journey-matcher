# Matcher

The TypeScript side: MCP server, indexer job, transcription job and matching approaches, as one pnpm workspace. Packages and how they depend on each other: [code components](../Documentation/design/architecture.md#2-code-components); commands: [build](../Documentation/build-deploy/build.md#development); adding an approach: [matching approaches](algorithms/README.md).

## Dependencies

```text
mcp-server, indexer  →  approaches  →  algorithms/*  →  core, db, download
transcriber          →  algorithms/keyword, db, download
evaluation           (no matcher package)
```

Programs reach the approaches only through `approaches` and the contracts in `core`; they also use `db` and `download` directly. The transcriber is the keyword approach's own job and imports it directly. Approaches import neither each other nor the programs; `core`, `db` and `download` import no other matcher package. A package can only import what its `package.json` lists.

## Rules

- **Files are named after their content** (`contracts.ts`, `downloader.ts`); programs start in `src/main.ts` (`evaluation`: `src/cli.ts`); `index.ts` only re-exports (`db`).
- **Factories get their dependencies:** `createX(dependencies)`; only `main.ts` creates the database pool and the downloader.
- **Tests sit next to the code** (`x.test.ts`); database tests use `createTestDatabase()`, skip without `TEST_DATABASE_URL` and must run on CI.
- **Checks:** `pnpm lint`, `pnpm typecheck` (strict, no unused code) and `pnpm test`; `make test` and CI run them.
