// Normalization of patient graphs and PubTator3 annotations into one representation, for the
// graph approach (#10, #80). See Documentation/design/graph-normalization.md.
export { normalizePatientGraph, parseDay } from "./patient.ts";
export { normalizePubTatorDocument, pubTatorDocuments } from "./pubtator.ts";
export {
  conceptOf,
  curated,
  type Dictionary,
  nameDictionary,
  resolve,
} from "./resolve.ts";
export { statusFromAttribute, statusFromText } from "./status.ts";
export { normalizeName } from "./text.ts";
export * from "./types.ts";
