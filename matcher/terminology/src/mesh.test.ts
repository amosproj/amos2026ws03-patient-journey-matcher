import { expect, test } from "vitest";
import { mesh } from "./mesh.ts";

test("German names: ZB MED's terms and their clinical forms, not NLM's English ones", () => {
  expect(mesh.german.D006333).toContain("Herzinsuffizienz");
  expect(mesh.german.D006333).not.toContain("Cardiac Failure");
  expect(mesh.german.D012004).toContain("Rektumkarzinom");
});
