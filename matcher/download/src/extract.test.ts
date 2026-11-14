import { expect, test } from "vitest";
import { extractText, formatOf } from "./extract.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

/** A one-page PDF with one line of text. */
function pdf(line: string): Uint8Array {
  const content = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`;
  return encode(`%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>> endobj
4 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj
5 0 obj <</Length ${content.length}>> stream
${content}
endstream endobj
trailer <</Root 1 0 R>>
%%EOF`);
}

test.each([
  ["jats", "application/xml", "xml"],
  ["file", "text/xml", "xml"],
  ["html", "text/html; charset=utf-8", "html"],
  ["pdf", "application/pdf", "pdf"],
  ["transcript", "text/vtt", "vtt"],
  ["transcript", "application/srt", "srt"],
  ["transcript", "application/x-subrip", "srt"],
  ["transcript", "application/json", "json"],
  ["transcript", "text/plain", "text"],
  ["audio", "audio/mpeg", "audio"],
  ["audio", "audio/x-m4a", undefined],
  ["file", "application/octet-stream", undefined],
  ["file", "application/json", undefined],
  ["file", null, undefined],
])("reads a %s locator of type %s as %s", (kind, media_type, format) => {
  expect(formatOf({ kind, media_type })).toBe(format);
});

test("reads the body of a JATS article, without front matter and references", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE article PUBLIC "-//NLM//DTD JATS (Z39.96) Journal Archiving DTD v1.3 20210610//EN" "JATS.dtd">
<article><front><article-meta><title-group><article-title>Title</article-title>
</title-group><abstract><p>Abstract</p></abstract></article-meta></front>
<body><sec><title>Introduction</title><p>Olaparib&#x2013;treated <italic>men</italic></p>
<p>with mCRPC &amp; BRCA2</p></sec></body>
<back><ref-list><ref><mixed-citation>Cited breast cancer paper</mixed-citation></ref></ref-list></back></article>`;

  expect(words(await extractText(encode(xml), "xml"))).toEqual([
    "Introduction",
    "Olaparib",
    "treated",
    "men",
    "with",
    "mCRPC",
    "BRCA2",
  ]);
});

test("reads the article of an HTML page, without page parts, formulas and references", async () => {
  const html = `<!DOCTYPE html><html><head><title>Page</title><style>p { }</style></head>
<body><nav>Menu</nav><article><h1>Prostate cancer</h1><p>Radiotherapy</p><p>after<math><mi>x</mi></math>surgery</p>
<section class="ltx_bibliography"><ul><li>Breast cancer reference</li></ul></section></article>
<script>var tracking = 1;</script><footer>About</footer></body></html>`;

  expect(words(await extractText(encode(html), "html"))).toEqual([
    "Prostate",
    "cancer",
    "Radiotherapy",
    "after",
    "surgery",
  ]);
});

test("reads a PDF", async () => {
  expect(await extractText(pdf("Olaparib for prostate cancer"), "pdf")).toBe(
    "Olaparib for prostate cancer",
  );
});

test("rejects a file that is no PDF", async () => {
  await expect(extractText(encode("<html>"), "pdf")).rejects.toThrow();
});

test("drops the references after a heading in the second half", async () => {
  const text =
    "Introduction\nProstate cancer\nOlaparib\nReferences\n[1] Breast cancer\n";

  expect(words(await extractText(encode(text), "text"))).toEqual([
    "Introduction",
    "Prostate",
    "cancer",
    "Olaparib",
  ]);
});

test("keeps the text after a references heading in the first half", async () => {
  const text =
    "Contents\nReferences\nProstate cancer screening and surveillance\n";

  expect(words(await extractText(encode(text), "text"))).toContain(
    "surveillance",
  );
});

test("reads the cues of a WebVTT transcript with their speakers", async () => {
  const vtt = `WEBVTT

NOTE made by speech recognition

1
00:00:01.000 --> 00:00:04.000
<v Dr. Smith>Welcome to the prostate podcast.

2
00:00:04.500 --> 00:00:06.000 align:start
Today: <c.loud>olaparib</c>.
`;

  expect(await extractText(encode(vtt), "vtt")).toBe(
    "Dr. Smith: Welcome to the prostate podcast.\nToday: olaparib.",
  );
});

test("reads the cues of an SRT transcript", async () => {
  const srt =
    "1\r\n00:00:01,000 --> 00:00:04,000\r\nWelcome.\r\n\r\n2\r\n00:00:04,500 --> 00:00:06,000\r\nOlaparib in myeloma.\r\n";

  expect(await extractText(encode(srt), "srt")).toBe(
    "Welcome.\nOlaparib in myeloma.",
  );
});

test("reads the segments of a JSON transcript", async () => {
  const json = JSON.stringify({
    version: "1.0.0",
    segments: [
      { speaker: "Host", startTime: 0, endTime: 1, body: "Hello." },
      { startTime: 1, endTime: 2, body: "Olaparib." },
    ],
  });

  expect(await extractText(encode(json), "json")).toBe(
    "Host: Hello.\nOlaparib.",
  );
});

// over 10 s each with backtracking patterns
test.each([
  ["a transcript of unclosed voice tags", "<v ".repeat(40_000), "vtt"],
  ["a transcript of unclosed tags", "<".repeat(100_000), "vtt"],
  [
    "a references heading before a long run of spaces",
    `Text\nReferences${" ".repeat(80_000)}x`,
    "text",
  ],
] as const)("reads %s in linear time", async (_name, text, format) => {
  await extractText(encode(text), format);
});
