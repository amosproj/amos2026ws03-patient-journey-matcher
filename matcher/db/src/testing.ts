// For the database tests of the packages, not for production code.
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";

const INIT_DIR = new URL("../../../db/init/", import.meta.url);

/** `TEST_DATABASE_URL`; without it the database tests are skipped, except on CI. */
export function testDatabaseUrl(): string | undefined {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url && process.env.CI) {
    throw new Error("TEST_DATABASE_URL must be set on CI");
  }
  return url || undefined;
}

export interface TestDatabase {
  readonly connectionString: string;
  pool: Pool;
  drop(): Promise<void>;
}

/**
 * A new database with `db/init/` applied, for the tests of one file. For indexes in a schema of
 * their own and with their own extensions, which a schema per test cannot keep apart.
 */
export async function createTestDatabase(url: string): Promise<TestDatabase> {
  const admin = new Pool({ connectionString: url });
  const name = `test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 LOCALE 'C'`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const target = new URL(url);
  target.pathname = `/${name}`;
  const connectionString = target.toString();
  const pool = new Pool({ connectionString });
  try {
    const files = (await readdir(INIT_DIR)).filter((file) =>
      file.endsWith(".sql"),
    );
    for (const file of files.sort()) {
      await pool.query(await readFile(new URL(file, INIT_DIR), "utf8"));
    }
  } catch (error) {
    await Promise.allSettled([pool.end()]);
    try {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    throw error;
  }
  return {
    connectionString,
    pool,
    async drop() {
      await pool.end();
      try {
        // no FORCE: it kills connections still closing; Postgres waits 5 s for them
        await admin.query(`DROP DATABASE ${name}`);
      } catch (error) {
        // leaked connection: drop anyway, then report it
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        throw error;
      } finally {
        await admin.end();
      }
    },
  };
}
