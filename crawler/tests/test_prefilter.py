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
    scoped = f"{database}{'&' if '?' in database else '?'}search_path={schema},public"
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


@pytest.mark.postgres
def test_propose_stores_proposals_and_raw_answers(prefilter, url, tmp_path, monkeypatch):
    monkeypatch.setattr(prefilter, "LABELS", tmp_path / "labels.json")
    insert(url, doc("pubmed:1", title="Mice"), doc("pubmed:2", title="Trial"))
    data = prefilter.load_labels(prefilter.LABELS)
    prefilter.add_documents(data, ["pubmed:1", "pubmed:2", "pubmed:404"], "train")
    data["documents"][1]["proposal"] = {"label": "keep", "group": None, "reason": "old"}
    prefilter.save_labels(prefilter.LABELS, data)
    prompts: list[str] = []

    def generate(prompt: str) -> str:
        prompts.append(prompt)
        return '{"label": "unhelpful", "group": 1, "reason": "mice"}' if "Mice" in prompt else "?"

    asyncio.run(prefilter.propose(url, "train", None, generate))
    entries = {e["id"]: e for e in prefilter.load_labels(prefilter.LABELS)["documents"]}
    assert len(prompts) == 1  # pubmed:2 already has a proposal; pubmed:404 is not stored
    assert entries["pubmed:1"]["proposal"]["label"] == "unhelpful"
    assert entries["pubmed:1"]["proposal"]["model"] == "{}@{}".format(*prefilter.PROPOSER)
    assert entries["pubmed:2"]["proposal"]["reason"] == "old"
    assert entries["pubmed:404"]["proposal"] is None


@pytest.mark.postgres
def test_propose_keeps_an_unparsable_answer_for_checking(prefilter, url, tmp_path, monkeypatch):
    monkeypatch.setattr(prefilter, "LABELS", tmp_path / "labels.json")
    insert(url, doc("pubmed:1"))
    data = prefilter.load_labels(prefilter.LABELS)
    prefilter.add_documents(data, ["pubmed:1"], "train")
    prefilter.save_labels(prefilter.LABELS, data)
    asyncio.run(prefilter.propose(url, None, None, lambda prompt: "I am not sure."))
    entry = prefilter.load_labels(prefilter.LABELS)["documents"][0]
    assert entry["proposal"] is None and entry["proposal_raw"] == "I am not sure."
    # A raw answer counts as tried: a second run does not ask again.
    asyncio.run(prefilter.propose(url, None, None, lambda prompt: pytest.fail("asked again")))


def embedded(url: str, vectors: dict[str, list[float] | None]) -> str:
    """A table shaped like the AI index's, in the test schema; returns its name."""

    async def main() -> None:
        connection = await asyncpg.connect(url)
        try:
            await connection.execute(
                "CREATE TABLE emb (document_id text PRIMARY KEY REFERENCES documents (id),"
                " document_changed_at timestamptz NOT NULL DEFAULT now(), embedding vector(2))"
            )
            for document_id, vector in vectors.items():
                await connection.execute(
                    "INSERT INTO emb (document_id, embedding) VALUES ($1, $2::text::vector)",
                    document_id,
                    None if vector is None else json.dumps(vector),
                )
        finally:
            await connection.close()

    asyncio.run(main())
    return "emb"


@pytest.mark.postgres
def test_embeddings_skip_missing_and_null_vectors(prefilter, url):
    insert(url, doc("pubmed:1"), doc("pubmed:2"), doc("pubmed:3"))
    table = embedded(url, {"pubmed:1": [0.5, -1.0], "pubmed:2": None})
    found = run(lambda c: prefilter.embeddings(c, ["pubmed:1", "pubmed:2", "pubmed:3"], table), url)
    assert found == {"pubmed:1": [0.5, -1.0]}


@pytest.mark.postgres
def test_embeddings_refuse_a_missing_table(prefilter, url):
    with pytest.raises(SystemExit, match="no_such_table"):
        run(lambda c: prefilter.embeddings(c, ["pubmed:1"], "no_such_table"), url)


def test_keep_probability_is_the_logistic_of_the_score(prefilter):
    assert prefilter.keep_probability([1.0, -1.0], 0.0, [2.0, 2.0]) == pytest.approx(0.5)
    assert prefilter.keep_probability([1.0], 0.0, [10.0]) > 0.99
    assert prefilter.keep_probability([1.0], 0.0, [-1000.0]) == pytest.approx(0.0)


def test_score_rows_skips_null_vectors(prefilter):
    rows = [("pubmed:1", [1.0]), ("pubmed:2", None), ("pubmed:3", [-1.0])]
    scored = list(prefilter.score_rows(rows, [1.0], 0.0))
    assert [document_id for document_id, _ in scored] == ["pubmed:1", "pubmed:3"]


def test_fit_separates_two_clusters(prefilter):
    pytest.importorskip("sklearn")
    vectors = [[1.0, 0.0]] * 30 + [[0.0, 1.0]] * 30
    labels = ["keep"] * 30 + ["unhelpful"] * 30
    weights, bias, out_of_fold = prefilter.fit(vectors, labels)
    assert prefilter.keep_probability(weights, bias, [1.0, 0.0]) > 0.9
    assert prefilter.keep_probability(weights, bias, [0.0, 1.0]) < 0.1
    assert len(out_of_fold) == 60


def test_labels_hash_changes_with_a_label(prefilter):
    entries = [{"id": "pubmed:1", "label": "keep"}, {"id": "pubmed:2", "label": "unhelpful"}]
    first = prefilter.labels_hash(entries)
    assert prefilter.labels_hash(list(reversed(entries))) == first
    entries[0]["label"] = "unhelpful"
    assert prefilter.labels_hash(entries) != first


@pytest.mark.postgres
def test_train_uses_checked_labels_the_rules_keep(prefilter, url, tmp_path, monkeypatch):
    pytest.importorskip("sklearn")
    monkeypatch.setattr(prefilter, "LABELS", tmp_path / "labels.json")
    monkeypatch.setattr(prefilter, "MODEL", tmp_path / "model.json")
    keep = [f"pubmed:{i}" for i in range(30)]
    unhelpful = [f"pubmed:{i}" for i in range(30, 60)]
    insert(url, *[doc(i) for i in keep + unhelpful], doc("pubmed:99", summary=None))
    vectors = {i: [1.0, 0.0] for i in keep} | {i: [0.0, 1.0] for i in unhelpful}
    table = embedded(url, vectors | {"pubmed:99": [0.0, 1.0]})
    data = prefilter.load_labels(prefilter.LABELS)
    prefilter.add_documents(data, [*keep, *unhelpful, "pubmed:99", "pubmed:98"], "train")
    for entry in data["documents"]:
        if entry["id"] != "pubmed:98":  # pubmed:98 stays unchecked
            entry["label"] = "keep" if entry["id"] in keep else "unhelpful"
            entry["group"] = None if entry["id"] in keep else 1
    prefilter.save_labels(prefilter.LABELS, data)
    asyncio.run(prefilter.train(url, table))
    model = json.loads((tmp_path / "model.json").read_text())
    assert model["trained_on"] == 60  # pubmed:99 is dropped by a rule, pubmed:98 unchecked
    assert model["threshold"] is None  # fewer than 100 below any cut-off
    assert len(model["weights"]) == 2 and model["embeddings"] == table
    assert model["labels_hash"] == prefilter.labels_hash(prefilter.checked(data, "train"))


def entry(document_id: str, sets: list[str], label: str | None, **fields: Any) -> dict[str, Any]:
    group = 1 if label == "unhelpful" else None
    return {
        "id": document_id,
        "sets": sets,
        "proposal": None,
        "proposal_raw": None,
        "label": label,
        "group": group,
        "note": "",
        "checked_at": None,
    } | fields


def counts(total: int = 1000, rules_all: int = 0, **rules: int) -> dict[str, Any]:
    base: dict[str, Any] = {"_total": {"pubmed": total}, "_all": {"pubmed": rules_all}}
    return base | {"_seconds": {"_all": 0.5}} | {rule: {"pubmed": n} for rule, n in rules.items()}


def model(threshold: float | None = 0.1, labels_hash: str = "", **fields: Any) -> dict[str, Any]:
    return {
        "weights": [1.0],
        "bias": 0.0,
        "threshold": threshold,
        "trained_on": 500,
        "below_threshold": 120,
        "labels_hash": labels_hash,
        "embeddings": "emb",
    } | fields


def scored(embedded: int = 0, dropped: int = 0) -> dict[str, Any]:
    return {"embedded": {"pubmed": embedded}, "dropped": {"pubmed": dropped}}


def test_summarize_counts_wrong_drops_and_safety(prefilter):
    drops = [entry(f"pubmed:{i}", ["drops-rules"], "unhelpful") for i in range(299)]
    labels = {"documents": [*drops, entry("pubmed:x", ["drops-rules"], "keep")]}
    result = prefilter.summarize(labels, counts(total=1000, rules_all=30), None, {}, {})
    rules = result["approaches"]["rules"]
    assert (rules["dropped"], rules["share"]) == (30, 0.03)
    assert (rules["checked"], rules["wrong"]) == (300, 1)
    assert rules["upper_bound"] == pytest.approx(0.0157, abs=2e-4)
    assert rules["passes"] == {"safety": True, "usefulness_2": True, "usefulness_3": True}
    assert result["approaches"]["rules+model"] is None  # no model yet


def test_summarize_counts_documents_without_embedding_as_cannot_judge(prefilter):
    result = prefilter.summarize(
        {"documents": []}, counts(total=100), model(), scored(embedded=40, dropped=4), {}
    )
    combined = result["approaches"]["rules+model"]
    assert combined["cannot_judge"] == 60
    assert combined["dropped"] == 10  # 4 of 40 embedded, scaled to the 100 the rules keep
    assert combined["extrapolated"] is True


def test_summarize_model_safety_needs_both_samples(prefilter):
    rule_drops = [entry(f"pubmed:r{i}", ["drops-rules"], "unhelpful") for i in range(300)]
    model_drops = [entry(f"pubmed:m{i}", ["drops-model"], "keep") for i in range(2)]
    model_drops += [entry(f"pubmed:n{i}", ["drops-model"], "unhelpful") for i in range(298)]
    labels = {"documents": rule_drops + model_drops}
    result = prefilter.summarize(labels, counts(), model(), scored(embedded=10), {})
    assert result["approaches"]["rules"]["passes"]["safety"]
    combined = result["approaches"]["rules+model"]
    assert (combined["checked"], combined["wrong"]) == (300, 2)
    assert not combined["passes"]["safety"]


def test_summarize_reports_each_rule_with_its_own_checks(prefilter):
    labels = {
        "documents": [
            entry("pubmed:1", ["drops-rules"], "unhelpful"),
            entry("pubmed:2", ["drops-rule:erratum"], "keep"),
            entry("pubmed:3", ["drops-rules"], None),
        ]
    }
    hits = {"pubmed:1": ["no_summary", "erratum"], "pubmed:2": ["erratum"], "pubmed:3": ["erratum"]}
    result = prefilter.summarize(labels, counts(erratum=7, no_summary=3), None, {}, {}, hits)
    assert result["rules"]["erratum"] | {"by_source": None} == {
        "dropped": 7,
        "by_source": None,
        "checked": 2,
        "wrong": 1,
        "seconds": None,
        "variant": False,
    }
    assert result["rules"]["no_summary"]["checked"] == 1


def test_summarize_marks_model_stale_when_train_labels_changed(prefilter):
    labels = {"documents": [entry("pubmed:1", ["train"], "keep")]}
    result = prefilter.summarize(labels, counts(), model(labels_hash="old"), scored(), {})
    assert result["model"]["stale"]
    fresh = prefilter.labels_hash(labels["documents"])
    assert not prefilter.summarize(labels, counts(), model(labels_hash=fresh), scored(), {})[
        "model"
    ]["stale"]


def test_summarize_reports_llm_agreement_and_the_random_sample(prefilter):
    proposal = {"label": "unhelpful", "group": 2, "reason": "x", "model": "m"}
    labels = {
        "documents": [
            entry("pubmed:1", ["random"], "unhelpful", group=2, proposal=proposal),
            entry("pubmed:2", ["random"], "keep", proposal=proposal),
            entry("pubmed:3", ["random"], None, proposal=proposal),
        ]
    }
    result = prefilter.summarize(labels, counts(), None, {}, {})
    assert result["llm_agreement"] == {"checked": 2, "agreed": 1}
    assert result["random"] == {"checked": 2, "unhelpful": 1, "by_group": {"1": 0, "2": 1}}


def test_drop_samples_are_added_once(prefilter):
    data = {"version": 1, "guide": [], "documents": []}
    prefilter.add_drop_samples(
        data, ["pubmed:1", "pubmed:2"], ["pubmed:3"], {"erratum": ["pubmed:4"]}
    )
    before = json.dumps(data, sort_keys=True)
    prefilter.add_drop_samples(data, ["pubmed:9"], ["pubmed:8"], {"erratum": ["pubmed:7"]})
    assert json.dumps(data, sort_keys=True) == before
    sets = {e["id"]: e["sets"] for e in data["documents"]}
    assert sets == {
        "pubmed:1": ["drops-rules"],
        "pubmed:2": ["drops-rules"],
        "pubmed:3": ["drops-model"],
        "pubmed:4": ["drops-rule:erratum"],
    }


def test_drop_samples_keep_labels_of_documents_already_known(prefilter):
    data = {"version": 1, "guide": [], "documents": [entry("pubmed:1", ["train"], "keep")]}
    prefilter.add_drop_samples(data, ["pubmed:1"], [], {})
    assert data["documents"] == [entry("pubmed:1", ["train", "drops-rules"], "keep")]


@pytest.fixture
def study(prefilter, url, tmp_path, monkeypatch):
    """10 documents the rules drop, 10 the model drops, 10 it keeps, 2 without an embedding."""
    for name in ("LABELS", "MODEL", "RESULTS"):
        monkeypatch.setattr(prefilter, name, tmp_path / f"{name.lower()}.json")
    low = [f"pubmed:{i}" for i in range(10, 20)]
    high = [f"pubmed:{i}" for i in range(20, 30)]
    insert(
        url,
        *[doc(f"pubmed:{i}", summary=None) for i in range(10)],
        *[doc(i) for i in low + high],
        doc("pubmed:30"),
        doc("pubmed:31"),
    )
    vectors = {i: [0.0, 1.0] for i in low} | {i: [1.0, 0.0] for i in high} | {"pubmed:31": None}
    table = embedded(url, vectors)
    model = {
        "weights": [5.0, -5.0],
        "bias": 0.0,
        "threshold": 0.5,
        "trained_on": 500,
        "below_threshold": 120,
        "labels_hash": "",
        "embeddings": table,
    }
    prefilter.MODEL.write_text(json.dumps(model))
    return table


@pytest.mark.postgres
def test_measure_writes_results_and_drop_samples(prefilter, url, study):
    asyncio.run(prefilter.measure(url, study))
    result = json.loads(prefilter.RESULTS.read_text())
    assert result["total"] == 32
    assert result["approaches"]["rules"]["dropped"] == 10
    combined = result["approaches"]["rules+model"]
    # 10 of 20 embedded are dropped, scaled to the 22 the rules keep: 11.
    assert (combined["dropped"], combined["cannot_judge"]) == (21, 2)
    assert result["timing"]["model_ms_per_document"] >= 0
    sets = {e["id"]: e["sets"] for e in prefilter.load_labels(prefilter.LABELS)["documents"]}
    assert sorted(i for i, s in sets.items() if "drops-rules" in s) == [
        f"pubmed:{i}" for i in range(10)
    ]
    assert len([i for i, s in sets.items() if "drops-model" in s]) == 10


@pytest.mark.postgres
def test_measure_again_keeps_samples_and_labels(prefilter, url, study):
    asyncio.run(prefilter.measure(url, study))
    data = prefilter.load_labels(prefilter.LABELS)
    data["documents"][0] |= {"label": "keep", "note": "a person checked this"}
    prefilter.save_labels(prefilter.LABELS, data)
    asyncio.run(prefilter.measure(url, study))
    assert prefilter.load_labels(prefilter.LABELS) == data


@pytest.mark.postgres
def test_measure_without_a_model_reports_the_rules(prefilter, url, study):
    prefilter.MODEL.unlink()
    asyncio.run(prefilter.measure(url, study))
    result = json.loads(prefilter.RESULTS.read_text())
    assert result["approaches"]["rules+model"] is None and result["model"] is None
    assert result["rules"]["no_summary"]["checked"] == 0
