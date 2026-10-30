import { Pool } from "pg";
import { expect, test } from "vitest";

test("creates a pg pool without connecting", () => {
  expect(new Pool().totalCount).toBe(0);
});
