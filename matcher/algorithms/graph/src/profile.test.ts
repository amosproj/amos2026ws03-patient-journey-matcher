import { expect, test } from "vitest";
import { profileOf, profilesOf } from "./profile.ts";
import { lung } from "./profiles/lung.ts";
import { prostate } from "./profiles/prostate.ts";

test("a patient's diagnoses find the profile of his disease, also by a narrower form", () => {
  expect(profileOf(["mesh:D011471"])).toBe(prostate);
  // type 2 diabetes beside castration-resistant prostate cancer
  expect(profileOf(["mesh:D003924", "mesh:D064129"])).toBe(prostate);
  expect(profileOf(["mesh:D008175"])).toBe(lung);
  expect(profileOf(["mesh:D001943"])).toBeUndefined(); // breast cancer
  expect(profileOf([])).toBeUndefined();
});

test("a patient with several profiled diseases gets each profile", () => {
  // castration-resistant prostate cancer and lung cancer, beside type 2 diabetes
  expect(profilesOf(["mesh:D064129", "mesh:D003924", "mesh:D008175"])).toEqual([
    prostate,
    lung,
  ]);
  expect(profilesOf(["mesh:D003924"])).toEqual([]);
});
