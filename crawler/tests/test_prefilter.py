"""The document pre-filter study (scripts/prefilter.py, #92) without its heavy dependencies:
the labels file, the safety statistics, the rules, the samples and the summary of the results."""

import asyncio
import importlib.util
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import asyncpg
import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def prefilter(monkeypatch):
    spec = importlib.util.spec_from_file_location("prefilter_test", ROOT / "scripts/prefilter.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


async def execute(url: str, sql: str, *args: Any) -> None:
    connection = await asyncpg.connect(url)
    try:
        await connection.execute(sql, *args)
    finally:
        await connection.close()


def run(query: Any, url: str) -> Any:
    """`query(connection)` on a read-only connection, as the script opens them."""

    async def main() -> Any:
        connection = await asyncpg.connect(
            url, server_settings={"default_transaction_read_only": "on"}
        )
        try:
            return await query(connection)
        finally:
            await connection.close()

    return asyncio.run(main())


@pytest.fixture
def url() -> Iterator[str]:
    """A fresh schema with `db/init/` applied at `TEST_DATABASE_URL`; dropped at the end."""
    database = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not database:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set on CI")
        pytest.skip("TEST_DATABASE_URL is not set")
    asyncio.run(execute(database, "CREATE EXTENSION IF NOT EXISTS vector"))
    schema = f"test_{uuid4().hex[:12]}"
    asyncio.run(execute(database, f"CREATE SCHEMA {schema}"))
    scoped = f"{database}{'&' if '?' in database else '?'}search_path={schema}"
    try:
        for path in sorted((ROOT / "db/init").glob("*.sql")):
            asyncio.run(execute(scoped, path.read_text(encoding="utf-8")))
        yield scoped
    finally:
        asyncio.run(execute(database, f"DROP SCHEMA {schema} CASCADE"))


CONTENT_TYPES = {"pubmed": "journal_article", "youtube": "video", "zenodo": "report"}


def doc(document_id: str, **fields: Any) -> dict[str, Any]:
    source, native_id = document_id.split(":")
    return {
        "id": document_id,
        "source": source,
        "native_id": native_id,
        "content_type": CONTENT_TYPES[source],
        "title": f"Title {document_id}",
        "summary": "x" * 500,
        "publication_types": [],
        "full_text": [],
        "canonical_url": f"https://example.org/{native_id}",
    } | fields


def insert(url: str, *documents: dict[str, Any]) -> None:
    async def main() -> None:
        connection = await asyncpg.connect(url)
        try:
            for document in documents:
                await connection.execute(
                    "INSERT INTO documents (id, source, native_id, content_type, title, summary,"
                    " publication_types, full_text, canonical_url, retrieved_at)"
                    " VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())",
                    document["id"],
                    document["source"],
                    document["native_id"],
                    document["content_type"],
                    document["title"],
                    document["summary"],
                    document["publication_types"],
                    json.dumps(document["full_text"]),
                    document["canonical_url"],
                )
        finally:
            await connection.close()

    asyncio.run(main())


def test_cli_has_the_four_subcommands(prefilter, capsys):
    with pytest.raises(SystemExit):
        prefilter.main(["--help"])
    out = capsys.readouterr().out
    for command in ("sample", "propose", "train", "measure"):
        assert command in out


def test_load_labels_starts_with_the_guide_when_missing(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    assert data == {"version": 1, "guide": prefilter.GUIDE, "documents": []}
    assert len(prefilter.GUIDE) == 6


def test_add_documents_keeps_labels_on_rerun(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    assert prefilter.add_documents(data, ["pubmed:1", "pubmed:2"], "train") == 2
    data["documents"][0] |= {"label": "keep", "note": "trial"}
    assert prefilter.add_documents(data, ["pubmed:1", "pubmed:3"], "random") == 1
    first = data["documents"][0]
    assert first["sets"] == ["train", "random"]
    assert (first["label"], first["note"]) == ("keep", "trial")
    assert len(data["documents"]) == 3


def test_new_entries_have_no_label_and_no_proposal(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    prefilter.add_documents(data, ["pubmed:1"], "train")
    assert data["documents"][0] == {
        "id": "pubmed:1",
        "sets": ["train"],
        "proposal": None,
        "proposal_raw": None,
        "label": None,
        "group": None,
        "note": "",
        "checked_at": None,
    }


def test_checked_lists_only_labeled_entries_of_a_set(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    prefilter.add_documents(data, ["pubmed:1", "pubmed:2"], "train")
    data["documents"][1]["label"] = "keep"
    assert [entry["id"] for entry in prefilter.checked(data, "train")] == ["pubmed:2"]
    assert prefilter.checked(data, "random") == []


def test_save_labels_round_trips_and_leaves_no_temp_file(prefilter, tmp_path):
    path = tmp_path / "labels.json"
    data = prefilter.load_labels(path)
    prefilter.add_documents(data, ["pubmed:1"], "train")
    prefilter.save_labels(path, data)
    assert prefilter.load_labels(path) == data
    assert [p.name for p in tmp_path.iterdir()] == ["labels.json"]


def test_upper_bound_matches_the_safety_bar(prefilter):
    assert prefilter.upper_bound(0, 300) == pytest.approx(0.00994, abs=1e-4)
    assert prefilter.upper_bound(1, 300) == pytest.approx(0.0157, abs=2e-4)
    assert prefilter.upper_bound(0, 0) == 1.0


def test_passes_safety_needs_300_checked_and_at_most_one_wrong(prefilter):
    assert prefilter.passes_safety(1, 300)
    assert not prefilter.passes_safety(2, 300)
    assert not prefilter.passes_safety(0, 299)


def test_choose_threshold_keeps_wrong_drops_under_one_percent(prefilter):
    unhelpful = [(i / 1000, "unhelpful") for i in range(150)]
    scores = unhelpful + [(0.149, "keep")] * 3 + [(0.9, "keep")] * 50
    # Below 0.149: 149 unhelpful, no keep. Below 0.9: 3 keep of 153, more than 1%.
    assert prefilter.choose_threshold(scores) == pytest.approx(0.149)


def test_choose_threshold_needs_100_documents_below(prefilter):
    scores = [(i / 1000, "unhelpful") for i in range(50)] + [(0.9, "keep")]
    assert prefilter.choose_threshold(scores) is None


RULE_ROWS = [
    doc("pubmed:1", summary=None),
    doc("pubmed:2", summary="x" * 150),
    doc("pubmed:3", publication_types=["Published Erratum"]),
    doc("pubmed:4", summary=None, publication_types=["Letter"]),
    doc("pubmed:5", full_text=[{"url": "https://example.org/5.pdf"}]),
    doc("pubmed:6", title="Correction to: PSA after surgery"),
    doc("pubmed:7", summary="   "),
    doc("pubmed:8", publication_types=["Editorial"]),
    doc("youtube:9", summary="short"),
]


@pytest.mark.postgres
@pytest.mark.parametrize(
    "rule, expected",
    [
        ("no_summary", {"pubmed:1", "pubmed:4", "pubmed:7"}),
        ("short_summary", {"pubmed:2", "youtube:9"}),
        ("erratum", {"pubmed:3", "pubmed:6"}),
        ("reaction_without_abstract", {"pubmed:4"}),
    ],
)
def test_rules_match_their_documents(prefilter, url, rule, expected):
    insert(url, *RULE_ROWS)
    hits = run(lambda connection: prefilter.rule_hits(connection, rule, 100, 0.5), url)
    assert set(hits) == expected


@pytest.mark.postgres
def test_full_text_variant_spares_documents_with_a_link(prefilter, url):
    insert(
        url,
        doc("pubmed:1", summary=None, full_text=[{"url": "https://example.org/1.pdf"}]),
        doc("pubmed:2", summary=None),
    )
    hits = run(lambda c: prefilter.rule_hits(c, "no_summary_no_full_text", 100, 0.5), url)
    assert hits == ["pubmed:2"]


def test_rule_set_holds_the_four_rules_without_variants(prefilter):
    assert prefilter.RULE_SET == [
        "no_summary",
        "short_summary",
        "erratum",
        "reaction_without_abstract",
    ]
    assert set(prefilter.RULES) == set(prefilter.RULE_SET) | {
        "no_summary_no_full_text",
        "short_summary_no_full_text",
    }


@pytest.mark.postgres
def test_rule_counts_per_rule_and_source(prefilter, url):
    insert(url, *RULE_ROWS)
    counts = run(prefilter.rule_counts, url)
    assert counts["no_summary"] == {"pubmed": 3}
    assert counts["short_summary"] == {"pubmed": 1, "youtube": 1}
    assert counts["erratum"] == {"pubmed": 2}
    assert counts["reaction_without_abstract"] == {"pubmed": 1}
    assert counts["no_summary_no_full_text"] == {"pubmed": 3}
    # pubmed:1, 2, 3, 4, 6, 7 and youtube:9 are dropped; pubmed:5 and 8 are kept.
    assert counts["_all"] == {"pubmed": 6, "youtube": 1}
    assert counts["_total"] == {"pubmed": 8, "youtube": 1}
    assert set(counts["_seconds"]) == set(prefilter.RULES) | {"_all"}
    assert all(seconds >= 0 for seconds in counts["_seconds"].values())


def test_never_above_one_reads_the_llm_grades(prefilter, tmp_path):
    path = tmp_path / "grades.json"
    points = {
        "p1": {"grades": {"3": "pubmed:1", "1": "pubmed:2 pubmed:3", "0": "pubmed:4"}},
        "p2": {"grades": {"1": "pubmed:1", "0": "pubmed:3"}},
    }
    path.write_text(json.dumps({"points": points}))
    assert prefilter.never_above_one(path) == ["pubmed:2", "pubmed:3", "pubmed:4"]


@pytest.mark.postgres
def test_sample_train_has_no_duplicates_and_fills_short_groups(prefilter, url):
    insert(url, *[doc(f"pubmed:{i}") for i in range(40)])
    ids = run(lambda c: prefilter.sample_train(c, n=20), url)
    assert len(ids) == len(set(ids)) == 20


@pytest.mark.postgres
def test_sample_train_takes_rule_hits_and_lab_titles(prefilter, url):
    insert(
        url,
        *[doc(f"pubmed:{i}") for i in range(200)],
        doc("pubmed:900", summary=None),
        doc("pubmed:901", title="Enzalutamide resistance in a mouse xenograft model"),
    )
    ids = run(lambda c: prefilter.sample_train(c, n=20), url)
    assert {"pubmed:900", "pubmed:901"} <= set(ids)


@pytest.mark.postgres
def test_sample_train_stops_when_the_table_is_smaller(prefilter, url):
    insert(url, *[doc(f"pubmed:{i}") for i in range(5)])
    assert len(run(lambda c: prefilter.sample_train(c, n=20), url)) == 5


@pytest.mark.postgres
def test_sample_random_is_repeatable(prefilter, url):
    insert(url, *[doc(f"pubmed:{i}") for i in range(50)])
    first = run(lambda c: prefilter.sample_random(c, n=10), url)
    assert len(set(first)) == 10
    assert run(lambda c: prefilter.sample_random(c, n=10), url) == first


@pytest.mark.postgres
def test_connect_refuses_writes(prefilter, url):
    async def write() -> None:
        connection = await prefilter.connect(url)
        try:
            await connection.execute("DELETE FROM documents")
        finally:
            await connection.close()

    with pytest.raises(asyncpg.ReadOnlySQLTransactionError):
        asyncio.run(write())


@pytest.mark.postgres
def test_sample_command_adds_to_the_labels_file(prefilter, url, tmp_path, monkeypatch):
    monkeypatch.setattr(prefilter, "LABELS", tmp_path / "labels.json")
    insert(url, *[doc(f"pubmed:{i}") for i in range(10)])
    prefilter.main(["--database-url", url, "sample", "--set", "random", "--n", "4"])
    prefilter.main(["--database-url", url, "sample", "--set", "random", "--n", "4"])
    data = prefilter.load_labels(tmp_path / "labels.json")
    assert len(data["documents"]) == 4
    assert all(entry["sets"] == ["random"] for entry in data["documents"])


def test_build_prompt_has_the_guide_and_cuts_long_summaries(prefilter):
    document = {
        "title": "T",
        "source": "pubmed",
        "content_type": "journal_article",
        "publication_types": ["Review"],
        "summary": "a" * 9000,
    }
    prompt = prefilter.build_prompt(document, prefilter.GUIDE)
    assert "In doubt, keep" in prompt
    assert "Altered glycosylation in prostate cancer" in prompt
    assert "a" * 4000 in prompt and "a" * 4001 not in prompt
    assert "Review" in prompt


def test_build_prompt_says_when_there_is_no_summary(prefilter):
    document = {"title": "T", "source": "youtube", "content_type": "video", "summary": None}
    assert "(none)" in prefilter.build_prompt(document, prefilter.GUIDE)


@pytest.mark.parametrize(
    "text, expected",
    [
        (
            '{"label": "unhelpful", "group": 1, "reason": "cell lines only"}',
            {"label": "unhelpful", "group": 1, "reason": "cell lines only"},
        ),
        (
            'Sure! {"label": "keep", "group": null, "reason": "trial"} done',
            {"label": "keep", "group": None, "reason": "trial"},
        ),
        ('{"label": "unhelpful", "group": null, "reason": "x"}', None),
        ('{"label": "keep", "group": 2, "reason": "x"}', None),
        ('{"label": "maybe", "group": 1, "reason": "x"}', None),
        ('{"label": "keep", "group": null, "reason": ""}', None),
        ('{"label": "keep", "group": null', None),
        ("no json here", None),
    ],
)
def test_parse_answer(prefilter, text, expected):
    assert prefilter.parse_answer(text) == expected
