import { normalizeName } from "@matcher/terminology";
import { type DiseaseProfile, PROFILES } from "./profile.ts";
import { conceptOf } from "./resolve.ts";
import { statusFromText } from "./status.ts";

/** The histology kinds of a profile and the names that find them */
export type Histology = {
  profile: DiseaseProfile;
  name: string;
  kinds: readonly string[];
  names: ReadonlyMap<string, string>;
};

// Short values only identify a kind in a record of the profile's disease.
export const HISTOLOGIES: readonly Histology[] = PROFILES.flatMap((profile) => {
  if (!profile.histology) return [];
  const names = new Map<string, string>();
  for (const [id, short] of Object.entries(profile.histology.kinds))
    for (const name of [...(conceptOf(id)?.names ?? []), ...short])
      names.set(normalizeName(name), id);
  return [
    {
      profile,
      name: profile.histology.name,
      kinds: Object.keys(profile.histology.kinds),
      names,
    },
  ];
});

/** A short value only counts in a labelled field. Keep an explicit exclusion with its kind. */
export function histologyOf(
  { kinds, names }: Histology,
  text: string,
  field?: unknown,
) {
  const value =
    typeof field === "string"
      ? field
      : /(?:^|[.;\n])\s*histolog(?:y|ie)\s*:\s*([^.;!?\n]+)(?=[.;\n]|$)/i.exec(
          text,
        )?.[1];
  if (!value || value.includes("?")) return;
  const id = names.get(normalizeName(value));
  if (id) {
    const status = statusFromText(text, [value])?.status ?? "asserted";
    return { id, status };
  }
  for (const kind of kinds) {
    const kindNames = [...names]
      .filter(([, id]) => id === kind)
      .map(([name]) => name);
    const status = statusFromText(value, kindNames)?.status;
    if (status === "negated" || status === "suspected")
      return { id: kind, status };
  }
}
