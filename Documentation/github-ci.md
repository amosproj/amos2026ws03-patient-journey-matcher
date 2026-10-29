# GitHub CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on every pull request, on every push to `main`, and on demand from the Actions tab.

Each job runs its commands in order and stops at the first failure. They are the same commands as in the [README](../README.md#development-setup), so you can run them locally before you push.

## `crawler` job (Python, in `crawler/`)

| Command | Why |
|---|---|
| `uv sync --locked` | Installs the exact versions from `uv.lock`. Fails if `uv.lock` does not match `pyproject.toml`, so nobody forgets to commit the lockfile. |
| `uv run ruff check .` | Lint: finds bugs such as unused imports and undefined names. |
| `uv run ruff format --check .` | Fails on unformatted code without changing any file, so formatting does not show up in later diffs. |
| `uv run mypy src` | Strict type check, including Pydantic models. |
| `uv run pytest` | Runs the tests in `tests/`. |

## `matcher` job (TypeScript, in `matcher/`)

| Command | Why |
|---|---|
| `pnpm install --frozen-lockfile` | Installs the exact versions from `pnpm-lock.yaml`. Fails if the lockfile does not match the `package.json` files. |
| `pnpm lint` | Biome checks lint rules, formatting and import order without changing any file. |
| `pnpm typecheck` | `tsc` type-checks all packages, including the tests. |
| `pnpm test` | Runs the Vitest tests (`*.test.ts`) of all packages. |

## Limitations

- `backend/` is not checked. It is copied SS26 code that does not build yet (#27).
- The tests are smoke tests that only import the packages and their main dependencies.
- There is no vulnerability or licence scan.
- A failed check does not block merging until a repository admin makes `crawler` and `matcher` required status checks for `main`.
