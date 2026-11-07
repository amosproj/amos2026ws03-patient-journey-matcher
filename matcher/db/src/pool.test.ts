import { afterEach, expect, test, vi } from "vitest";
import { createPool } from "./pool.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("needs DATABASE_URL", () => {
  vi.stubEnv("DATABASE_URL", " ");

  expect(() => createPool()).toThrow("DATABASE_URL is not set");
});

test("creates a pool for DATABASE_URL without connecting", async () => {
  const url = "postgresql://amos:secret@127.0.0.1:5432/patient_journey_matcher";
  vi.stubEnv("DATABASE_URL", url);

  const pool = createPool();

  expect(pool.totalCount).toBe(0);
  expect(pool.options.connectionString).toBe(url);
  await pool.end();
});
