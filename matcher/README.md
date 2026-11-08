# Matcher

The TypeScript side: MCP server, indexer job and matching approaches, as one pnpm workspace. Packages: [development setup](../README.md#development-setup); adding an approach: [matching approaches](algorithms/README.md).

## Dependencies

```text
mcp-server, indexer  →  approaches  →  algorithms/*  →  core, db, download
```

Programs reach the approaches only through `approaches` and the contracts in `core`. Approaches import neither each other nor the programs; `core`, `db` and `download` import no other matcher package. A package can only import what its `package.json` lists.

## Rules

- **Files are named after their content** (`contracts.ts`, `downloader.ts`); programs start in `src/main.ts`; `index.ts` only re-exports (`db`).
- **Factories get their dependencies:** `createX(dependencies)`; only `main.ts` creates the database pool and the downloader.
- **Tests sit next to the code** (`x.test.ts`); database tests use `createTestDatabase()`, skip without `TEST_DATABASE_URL` and must run on CI.
- **Checks:** `pnpm lint`, `pnpm typecheck` (strict, no unused code) and `pnpm test`; `make test` and CI run them.
