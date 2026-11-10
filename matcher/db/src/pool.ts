import { Pool } from "pg";

/** A pool for `DATABASE_URL`, the variable the crawler uses too. It connects on first use. */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString?.trim()) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString: connectionString.trim() });
}
