import { conceptOf } from "./resolve.ts";
import { statusFromText } from "./status.ts";
import { normalizeName } from "./text.ts";

export const LUNG = "mesh:D008175";
export const NSCLC = "mesh:D002289";
export const SCLC = "mesh:D055752";

// These short histology values only identify a lung subtype in a lung cancer record.
const subtypes = new Map<string, string>();
for (const [id, ...shortNames] of [
  [NSCLC, "NSCLC", "non-small cell", "nichtkleinzellig"],
  [SCLC, "SCLC", "small cell", "kleinzellig"],
]) {
  for (const name of [...(conceptOf(id)?.names ?? []), ...shortNames])
    subtypes.set(normalizeName(name), id);
}

/** A short value only counts in a labelled field. Keep an explicit exclusion with its subtype. */
export function lungHistology(text: string, field?: unknown) {
  const value =
    typeof field === "string"
      ? field
      : /(?:^|[.;\n])\s*histolog(?:y|ie)\s*:\s*([^.;!?\n]+)(?=[.;\n]|$)/i.exec(
          text,
        )?.[1];
  if (!value || value.includes("?")) return;
  const id = subtypes.get(normalizeName(value));
  if (id) {
    const status = statusFromText(text, [value])?.status ?? "asserted";
    return { id, status };
  }
  for (const subtype of [NSCLC, SCLC]) {
    const names = [...subtypes]
      .filter(([, id]) => id === subtype)
      .map(([name]) => name);
    const status = statusFromText(value, names)?.status;
    if (status === "negated" || status === "suspected")
      return { id: subtype, status };
  }
}
