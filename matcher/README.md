# Matcher

The TypeScript side of the project: the MCP server, the indexer job and the matching approaches, as one pnpm workspace. What each package holds: [development setup](../README.md#development-setup). Adding an approach: [matching approaches](algorithms/README.md).

## Dependencies

```text
mcp-server, indexer  →  approaches  →  algorithms/*  →  core, db, download
```

The programs reach the approaches only through the list in `approaches` and the contracts in `core`. Approaches import neither each other nor the programs; `core`, `db` and `download` import no other matcher package. A package can only import what its `package.json` lists, so a wrong import fails the type check.

## Rules

- **Files are named after what they hold:** `contracts.ts`, `downloader.ts`, `registry.ts`. A program starts in `src/main.ts`. An `index.ts` only lists the exports of a package with several modules (`db`).
- **Factories get their dependencies:** packages export `createX(dependencies)` and receive the database or the downloader as arguments. Only `main.ts` creates them.
- **Tests sit next to the code:** `x.test.ts` tests `x.ts`. Database tests use `createTestDatabase()` from `@matcher/db/testing`; without `TEST_DATABASE_URL` they are skipped, on CI they must run.
- **Checks:** `pnpm lint` (Biome: recommended rules and formatting), `pnpm typecheck` (strict, no unused locals or parameters) and `pnpm test`. `make test` and CI run all three, CI with the database.
