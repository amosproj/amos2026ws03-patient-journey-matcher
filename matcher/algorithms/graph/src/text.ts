// Name normalization (Documentation/graph-normalization.md §4.1): every lookup and every
// comparison of names runs on this form, on the patient side and in the curated tables.

const LEADING_ICD = /^[a-z]\d{2}(\.\d{1,2})?\s+/;
const BRACKETED_ICD = /\(\s*[a-z]\d{2}(\.\d{1,2})?\s*\)/g;

/**
 * Lowercase, without diacritics (`ü` → `u`, `ß` → `ss`), without a leading or bracketed ICD
 * code, with every run of other characters than letters and digits as one space.
 * `C61 Prostatakarzinom` → `prostatakarzinom`, `PSMA-PET/CT` → `psma pet ct`.
 */
export function normalizeName(text: string): string {
  return text
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(BRACKETED_ICD, " ")
    .trim()
    .replace(LEADING_ICD, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a normalized text. */
export function words(text: string): string[] {
  const normalized = normalizeName(text);
  return normalized === "" ? [] : normalized.split(" ");
}
