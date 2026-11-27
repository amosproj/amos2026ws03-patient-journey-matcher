// shortcut: of a longer text only the start is read. The longest label, parameter or fact
// sentence of the synthetic patients has 234 characters. Reading the status of each disease in
// a text takes time with the square of its length, so a text of megabytes would block the server.
const MAX_TEXT = 2_000;

/** A patient text as the graph matcher reads it: at most its first 2,000 characters. */
export function clip(text: string): string {
  return text.slice(0, MAX_TEXT);
}
