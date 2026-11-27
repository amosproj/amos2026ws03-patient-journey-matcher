// Name normalization (Documentation/design/graph-normalization.md#entities): every lookup and every
// comparison of names runs on this form, on the patient side and in the curated tables.

const LEADING_ICD = /^[a-z]\d{2}(?: \d{1,2})? /; // after normalizing: `c61 0 …` was `C61.0 …`
const BRACKETED_ICD = /\(\s*[a-z]\d{2}(\.\d{1,2})?\s*\)/g;

/**
 * Lowercase, without diacritics (`ü` → `u`, `ß` → `ss`), without a bracketed ICD code, with
 * every run of other characters than letters and digits as one space.
 * `Prostatakarzinom (C61)` → `prostatakarzinom`, `PSMA-PET/CT` → `psma pet ct`. A leading code
 * stays: `P53 mutation` is a gene, not code P53; see `withoutLeadingCode`.
 */
export function normalizeName(text: string): string {
  return text
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(BRACKETED_ICD, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A normalized name without a leading ICD-10 code (`c61 prostatakarzinom` → `prostatakarzinom`),
 * or `undefined` when it has none. Only for lookups: the resolver tries the name as written
 * first, so `p53 mutation` is never taken for code P53 when a dictionary knows it.
 */
export function withoutLeadingCode(normalized: string): string | undefined {
  const rest = normalized.replace(LEADING_ICD, "");
  return rest === normalized || rest === "" ? undefined : rest;
}

/** The words of a normalized text. */
export function words(text: string): string[] {
  const normalized = normalizeName(text);
  return normalized === "" ? [] : normalized.split(" ");
}
