// Writes ../data/basic-words.json: common English words that are not medical. The keyword indexer
// drops them from full texts, so the index keeps keywords only. Run it again when NLM publishes a
// new MeSH year or the rule below changes, and commit the new list. From the repository root, with
// the MeSH descriptors from https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/:
//
//   node matcher/algorithms/keyword/scripts/basic-words.ts desc2026.gz
//
// A word is basic if it is among the 5,000 most frequent English words and is not medical.
// Medical are:
// - MeSH terms of one word in the tree branches A-H, M and N: anatomy, organisms, diseases, drugs,
//   procedures, psychology, phenomena, disciplines, persons and health care (blood, surgery,
//   patients, hospital);
// - words of longer MeSH terms in A, C, D and E outside the 1,000 most frequent words (failure in
//   "heart failure", survival, oral);
// - words of two or three letters outside the 2,000 most frequent: mostly abbreviations (PSA, DRE).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { createGunzip, gunzipSync } from "node:zlib";
import { decode } from "@msgpack/msgpack";
import { Parser } from "htmlparser2";

const COMMON = 5_000; // rarer words stay: drug names, abbreviations, also academic words
const FREQUENT = 1_000; // words of longer MeSH terms among these stay basic: "high", "level"
const SHORT_FREQUENT = 2_000; // short words among these stay basic: "us", "or"
// wordfreq's English frequencies (unchanged since wordfreq 2.5), pinned by commit and hash.
const WORDFREQ = "v3.2";
const WORDFREQ_URL =
  "https://raw.githubusercontent.com/rspeer/wordfreq/42233e6c36ce792031bcccfa17cdd0cec9af5fa7/wordfreq/data/large_en.msgpack.gz";
const WORDFREQ_SHA256 =
  "dffae8066b78dce0a6667cf5f58e567054f902674667090a7ac8a8a44628b05c";
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu; // as the indexer splits a text

/** The most frequent English words, most frequent first. */
async function frequentWords(count: number): Promise<string[]> {
  const response = await fetch(WORDFREQ_URL);
  if (!response.ok) throw new Error(`${WORDFREQ_URL}: HTTP ${response.status}`);
  const file = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(file).digest("hex");
  if (hash !== WORDFREQ_SHA256)
    throw new Error(`wordfreq data changed: ${hash}`);
  // A header, then the words by frequency in steps of a centibel.
  const [, ...steps] = decode(gunzipSync(file)) as [unknown, ...string[][]];
  // Without numbers of several digits, as wordfreq's top_n_list.
  return steps
    .flat()
    .filter((word) => !/^\p{Nd}[\p{Nd}.,]+/u.test(word))
    .slice(0, count);
}

/** The word in singular and plural: MeSH mostly lists one of them. */
function variants(word: string): string[] {
  return [
    word,
    `${word}s`,
    word.replace(/s$/, ""),
    word.replace(/ies$/, "y"),
    word.replace(/y$/, "ies"),
  ];
}

/** MeSH terms of one word (branches A-H, M, N) and the words of longer terms (A, C, D, E). */
async function medicalWords(path: string) {
  const whole = new Set<string>();
  const parts = new Set<string>();
  const open: string[] = [];
  let text = "";
  let names: string[] = [];
  let branches = new Set<string>();
  const parser = new Parser(
    {
      onopentag(name) {
        open.push(name);
        text = "";
      },
      ontext(chunk) {
        text += chunk;
      },
      onclosetag(name) {
        const parent = open.at(-2);
        if (name === "TreeNumber" && text) {
          branches.add(text[0] as string);
        } else if (
          name === "String" &&
          (parent === "Term" ||
            (parent === "DescriptorName" && open.at(-3) === "DescriptorRecord"))
        ) {
          names.push(text);
        } else if (name === "DescriptorRecord") {
          const has = (letters: string) =>
            [...letters].some((letter) => branches.has(letter));
          for (const term of names) {
            const words = term.toLowerCase().match(WORD) ?? [];
            const target =
              words.length === 1 && has("ABCDEFGHMN")
                ? whole
                : words.length > 1 && has("ACDE")
                  ? parts
                  : undefined;
            for (const word of target ? words : []) {
              for (const variant of variants(word)) target?.add(variant);
            }
          }
          names = [];
          branches = new Set();
        }
        open.pop();
      },
    },
    { xmlMode: true },
  );
  const xml = createReadStream(path).pipe(createGunzip()).setEncoding("utf8");
  for await (const chunk of xml) parser.write(chunk);
  parser.end();
  return { whole, parts };
}

const path = process.argv[2];
if (!path) throw new Error("Usage: node basic-words.ts desc<year>.gz");
const mesh = basename(path).replace(/\.gz$/, "");
const { whole, parts } = await medicalWords(path);
if (whole.size === 0) {
  throw new Error(`No MeSH descriptors in ${path}: pass desc<year>.gz`);
}
const common = await frequentWords(COMMON);
const ranks = new Map(common.map((word, index) => [word, index + 1]));
const words = common.filter((word, index) => {
  const base = word.replace(/'s$/, ""); // "patient's" counts as "patient"
  const rank = index + 1;
  const medical =
    whole.has(base) ||
    (parts.has(base) && (ranks.get(base) ?? rank) > FREQUENT);
  const abbreviation =
    word.length >= 2 && word.length <= 3 && rank > SHORT_FREQUENT;
  return /\p{L}/u.test(word) && !medical && !abbreviation;
});
const list = {
  description: `Basic English words, which the keyword index drops from full texts; most frequent first. Built by scripts/basic-words.ts from ${mesh}; do not edit.`,
  changes: `The ${COMMON.toLocaleString("en")} most frequent English words of wordfreq, without the medical ones.`,
  licence: "CC BY-SA 4.0, https://creativecommons.org/licenses/by-sa/4.0/",
  credits: [
    `Word frequencies: wordfreq ${WORDFREQ} by Robyn Speer, https://github.com/rspeer/wordfreq. They include the SUBTLEX word lists by Marc Brysbaert et al., freely available data (http://crr.ugent.be/programs-data/subtitle-frequencies), OpenSubtitles (http://www.opensubtitles.org), Google Books Ngrams (http://books.google.com/ngrams), Wikipedia and other sources listed by wordfreq.`,
    `Medical words: Medical Subject Headings ${mesh.replace(/^desc/, "")} (${mesh}), courtesy of the U.S. National Library of Medicine (NLM). NLM does not endorse this project.`,
  ],
  words,
};
await writeFile(
  new URL("../data/basic-words.json", import.meta.url),
  `${JSON.stringify(list, null, 2)}\n`,
);
