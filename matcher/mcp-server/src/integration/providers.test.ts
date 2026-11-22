import { readFileSync } from "node:fs";
import { testDatabaseUrl } from "@matcher/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHarness, FILLER, type Harness } from "./harness.ts";

const databaseUrl = testDatabaseUrl();

describe.skipIf(!databaseUrl)("podcast and PubMed sources", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(databaseUrl as string);
  });
  afterAll(async () => {
    await h?.close();
  });

  test("podcast transcript flows through real RSS parsing, indexing and MCP", async () => {
    h.providers.routes.set("/podcast.xml", [
      {
        type: "application/rss+xml",
        body: `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Clinical evidence</title><language>en</language><item><guid>episode1</guid><title>Clinical evidence discussion</title><pubDate>Wed, 01 Jan 2025 12:00:00 GMT</pubDate><enclosure url="https://fixtures.example.org/audio.mp3" type="audio/mpeg"/><podcast:transcript url="https://fixtures.example.org/transcript.vtt" type="text/vtt"/></item></channel></rss>`,
      },
    ]);
    h.providers.routes.set("/transcript.vtt", [
      {
        type: "text/vtt",
        body: `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\n${FILLER} Olaparib improves treatment outcomes.`,
      },
    ]);
    const summary = await h.crawl("podcast");
    expect(summary.failures).toBe(0);
    expect(summary.ids).toHaveLength(1);
    await h.index();
    expect((await h.match()).results.map((r) => r.source_id)).toContain(
      summary.ids[0],
    );
    const source = await h.source(summary.ids[0]);
    expect(source.downloads.map((d) => d.url)).toContain(
      `https://fixtures.example.org/transcript.vtt`,
    );
    expect(h.providers.requests).not.toContain("/audio.mp3");
  });

  test("crawled PubMed references keep their provenance and match a patient graph through MCP", async () => {
    const xml = (root: string, dtd: string, contents: string) =>
      `<?xml version="1.0"?><!DOCTYPE ${root} SYSTEM "${dtd}"><${root}>${contents}</${root}>`;
    h.providers.routes.set("/pubmed-search.xml", [
      {
        type: "application/xml",
        body: xml(
          "eSearchResult",
          "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20060628/esearch.dtd",
          "<Count>1</Count><RetMax>1</RetMax><RetStart>0</RetStart><IdList><Id>301</Id></IdList>",
        ),
      },
    ]);
    for (const id of [301, 302]) {
      h.providers.routes.set(`/pubmed-${id}.xml`, [
        {
          type: "application/xml",
          body: xml(
            "PubmedArticleSet",
            "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd",
            `<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">${id}</PMID><Article PubModel="Print"><Journal><JournalIssue CitedMedium="Print"><PubDate><Year>2025</Year></PubDate></JournalIssue><Title>Synthetic Journal</Title></Journal><ArticleTitle>Olaparib clinical evidence ${id}</ArticleTitle><Language>eng</Language></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${id}</ArticleId><ArticleId IdType="pmc">PMC${id}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`,
          ),
        },
      ]);
    }
    h.providers.routes.set("/pubmed-references.xml", [
      {
        type: "application/xml",
        body: xml(
          "eLinkResult",
          "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20101123/elink.dtd",
          "<LinkSet><DbFrom>pubmed</DbFrom><IdList><Id>301</Id></IdList><LinkSetDb><DbTo>pubmed</DbTo><LinkName>pubmed_pubmed_refs</LinkName><Link><Id>302</Id></Link></LinkSetDb></LinkSet>",
        ),
      },
    ]);
    // The listing advertises both synthetic article versions.
    h.providers.routes.set("/", [
      {
        type: "application/xml",
        body: '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CommonPrefixes><Prefix>PMC301.1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>PMC302.1/</Prefix></CommonPrefixes></ListBucketResult>',
      },
    ]);
    for (const id of [301, 302]) {
      h.providers.routes.set(`/metadata/PMC${id}.1.json`, [
        {
          type: "application/json",
          body: JSON.stringify({
            version: 1,
            license_code: "CC BY",
            xml_url: `s3://pmc-oa-opendata/PMC${id}.1/article.xml`,
          }),
        },
      ]);
      h.providers.routes.set(`/PMC${id}.1/article.xml`, [
        {
          type: "application/xml",
          body: `<article><body><p>${FILLER} Olaparib improves outcomes.</p></body></article>`,
        },
      ]);
    }
    const summary = await h.crawl("pubmed");
    expect(summary.failures).toBe(0);
    expect(summary.ids.sort()).toEqual(["pubmed:301", "pubmed:302"]);
    const cited = (
      await h.db.pool.query(
        "SELECT found_by FROM documents WHERE id = 'pubmed:302'",
      )
    ).rows[0];
    expect(JSON.stringify(cited.found_by)).toContain("pubmed:301");
    const annotations = JSON.parse(
      readFileSync(
        new URL(
          "../../../algorithms/graph/fixtures/pubtator/32343890.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    h.providers.routes.set(
      "/research/pubtator3-api/publications/export/biocjson",
      (url) => {
        const pmids = url.searchParams.get("pmids")?.split(",") ?? [];
        return {
          type: "application/json",
          body: JSON.stringify({
            PubTator3: pmids.map((id) => ({
              ...annotations,
              id,
              pmid: id,
              relations: id === "301" ? annotations.relations : [],
            })),
          }),
        };
      },
    );
    await h.index();
    const graph = JSON.parse(
      readFileSync(
        new URL(
          "../../../../patientdata/Patient-5/graph.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const request = {
      graph: { ...graph, as_of: "2026-12-08" },
      algorithm: "graph",
    };
    const count = h.providers.requests.length;
    const answer = await h.match(request);
    expect(answer).toMatchObject({
      degraded: false,
      algorithm: "graph",
      focus_event_id: "2026-12-08",
      results: [
        {
          rank: 1,
          source_id: "pubmed:301",
          score: 1,
          explanation: expect.stringContaining("treats"),
        },
        {
          rank: 2,
          source_id: "pubmed:302",
          explanation: expect.stringContaining("Matched the diagnosis"),
        },
      ],
    });
    expect((await h.match({ ...request, limit: 1 })).results).toHaveLength(1);
    expect(
      (await h.match({ ...request, content_types: ["video"] })).results,
    ).toEqual([]);
    await h.index();
    expect(h.providers.requests).toHaveLength(count);
    expect((await h.match()).results.map((r) => r.source_id)).toContain(
      "pubmed:302",
    );
    const source = await h.source("pubmed:302");
    expect(source.source_id).toBe("pubmed:302");
    expect(source.downloads[0].url).toBe(
      "https://pmc-oa-opendata.s3.amazonaws.com/PMC302.1/article.xml",
    );
    expect((await h.providers.fetchLocal(source.downloads[0].url)).status).toBe(
      200,
    );
    expect(
      (
        await h.db.pool.query(
          "SELECT status FROM keyword.full_texts WHERE document_id = 'pubmed:302'",
        )
      ).rows[0].status,
    ).toBe("indexed");
  });
});
