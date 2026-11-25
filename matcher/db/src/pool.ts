import { Pool } from "pg";

/**
 * A pool for `DATABASE_URL`, the variable the crawler uses too. It connects on first use.
 * `statementTimeoutMs` ends every query that runs longer: for the server, which has to answer.
 * The indexer goes without it, as building an index takes long.
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
  });
}
