import { expect, test } from "vitest";
import { profileOf } from "./profile.ts";
import { prostate } from "./profiles/prostate.ts";

test("a patient's diagnoses find the profile of his disease, also by a narrower form", () => {
  expect(profileOf(["mesh:D011471"])).toBe(prostate);
  // type 2 diabetes beside castration-resistant prostate cancer
  expect(profileOf(["mesh:D003924", "mesh:D064129"])).toBe(prostate);
  expect(profileOf(["mesh:D001943"])).toBeUndefined(); // breast cancer
  expect(profileOf([])).toBeUndefined();
});
