import { Pool } from "pg";

/**
 * A pool for `DATABASE_URL`, the variable the crawler uses too. It connects on first use.
 * `statementTimeoutMs` is for the server, which has to answer: it ends every query that runs
 * longer and turns JIT compilation off, which took longer than a search itself. The indexer goes
 * without both, as building an index takes long.
 */
export function createPool(
  connectionString = process.env.DATABASE_URL,
  statementTimeoutMs?: number,
): Pool {
  if (!connectionString?.trim()) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({
    connectionString: connectionString.trim(),
    statement_timeout: statementTimeoutMs,
    ...(statementTimeoutMs !== undefined && { options: "-c jit=off" }),
  });
}
