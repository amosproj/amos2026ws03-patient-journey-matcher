// Lung cancer profile: only its histologies, in data/profiles/lung.json

import data from "../../data/profiles/lung.json" with { type: "json" };
import type { DiseaseProfile } from "../profile.ts";

export const lung = data satisfies DiseaseProfile;
