import { Parser } from "htmlparser2";
import { getDocumentProxy, extractText as pdfText } from "unpdf";

/** How a full-text file is read. */
export type Format = "pdf" | "xml" | "html" | "vtt" | "srt" | "json" | "text";

const FORMATS: Record<string, Format> = {
  "application/pdf": "pdf",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/vtt": "vtt",
  "application/srt": "srt",
  "application/x-subrip": "srt",
  "text/srt": "srt",
  "text/plain": "text",
};

/**
 * The format of a locator by its stored media type (Zenodo and the PMC bucket serve every file
 * as octet-stream); undefined for audio, video, images, archives, Word files and unknown types.
 */
export function formatOf(locator: {
  kind: string;
  media_type: string | null;
}): Format | undefined {
  const type = locator.media_type?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "application/json") {
    return locator.kind === "transcript" ? "json" : undefined;
  }
  return FORMATS[type];
}

/** The text of a file; throws if the file is not readable in its format. */
export async function extractText(
  bytes: Uint8Array,
  format: Format,
): Promise<string> {
  if (format === "pdf") {
    const document = await getDocumentProxy(bytes, { verbosity: 0 });
    return cutReferences((await pdfText(document, { mergePages: true })).text);
  }
  const text = new TextDecoder().decode(bytes);
  switch (format) {
    case "xml":
      return markupText(text, true);
    case "html":
      return cutReferences(markupText(text, false));
    case "vtt":
    case "srt":
      return cueText(text);
    case "json":
      return segmentText(text);
    case "text":
      return cutReferences(text);
  }
}

// JATS: the front matter repeats the metadata of the row, the back matter holds the references.
const SKIPPED_XML = new Set([
  "front",
  "back",
  "ref-list",
  "mml:math",
  "tex-math",
]);
const SKIPPED_HTML = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "nav",
  "header",
  "footer",
  "math",
  "svg",
]);
// arXiv's LaTeXML pages mark the references with this class.
const BIBLIOGRAPHY = /\bltx_bibliography\b/;

/** The text of an XML or HTML document; each tag ends a line, so headings stay on their own. */
function markupText(markup: string, xmlMode: boolean): string {
  const parts: string[] = [];
  let skippedDepth = 0;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const skipped = xmlMode
          ? SKIPPED_XML.has(name)
          : SKIPPED_HTML.has(name) ||
            BIBLIOGRAPHY.test(attributes.class ?? "") ||
            attributes.role === "doc-bibliography";
        if (skippedDepth > 0 || skipped) skippedDepth++;
        parts.push("\n");
      },
      ontext(text) {
        if (skippedDepth === 0) parts.push(text);
      },
      onclosetag() {
        if (skippedDepth > 0) skippedDepth--;
        parts.push("\n");
      },
    },
    { xmlMode, decodeEntities: true },
  );
  parser.end(markup);
  return lines(parts.join(""));
}

/** A WebVTT or SRT transcript without header, notes, cue numbers and timings; speakers as "Name: ". */
function cueText(text: string): string {
  const cues = text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.includes("-->") &&
        !/^\s*(\d+|WEBVTT\b.*|NOTE\b.*|STYLE|REGION)\s*$/.test(line),
    )
    .join("\n");
  return lines(
    cues
      .replace(/<v(?:\.[^\s>]*)?\s+([^>]*)>/g, "$1: ")
      .replace(/<[^>]*>/g, ""),
  );
}

/** A transcript in the JSON format of the podcast namespace. */
function segmentText(json: string): string {
  const { segments } = JSON.parse(json) as {
    segments?: { speaker?: string; body?: string }[];
  };
  return (segments ?? [])
    .map(({ speaker, body = "" }) => (speaker ? `${speaker}: ${body}` : body))
    .join("\n");
}

const REFERENCES_HEADING =
  /^[ \t]*(?:\d+\.?[ \t]*)?(?:references|bibliography|literature cited|works cited)[ \t]*:?[ \t]*$/gim;

/** The text before its last references heading, if that is in the second half: cited titles would match like the paper's own words. */
function cutReferences(text: string): string {
  const heading = [...text.matchAll(REFERENCES_HEADING)].at(-1);
  return heading !== undefined && heading.index > text.length / 2
    ? text.slice(0, heading.index)
    : text;
}

function lines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
