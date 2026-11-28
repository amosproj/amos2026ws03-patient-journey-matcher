"""The Pre-filter screen's API in the debug UI: listing, saving and the results of the document
pre-filter study (#92). It only touches the JSON files in research/prefilter/."""

import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROPOSAL = {"label": "unhelpful", "group": 1, "reason": "cell lines only", "model": "m"}


def entry(document_id, sets, label=None, group=None, proposal=None):
    return {
        "id": document_id,
        "sets": sets,
        "proposal": proposal,
        "proposal_raw": None,
        "label": label,
        "group": group,
        "note": "",
        "checked_at": None,
    }


@pytest.fixture
def server(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location(
        "debug_prefilter_test_server", ROOT / "debug/server.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "PREFILTER_DIR", tmp_path)
    return module


@pytest.fixture
def labels_file(tmp_path):
    path = tmp_path / "labels.json"
    documents = [
        entry("pubmed:1", ["train"], "keep", proposal=PROPOSAL),
        entry("pubmed:2", ["train"], proposal=PROPOSAL),
        entry("pubmed:3", ["random"]),
        entry("pubmed:4", ["train", "drops-rules"], "unhelpful", 1, proposal=PROPOSAL),
    ]
    path.write_text(json.dumps({"version": 1, "guide": [{"kind": "k"}], "documents": documents}))
    return path


def test_status_compares_the_label_with_the_proposal(server):
    assert server.prefilter_status(entry("a", [], proposal=PROPOSAL)) == "unchecked"
    assert server.prefilter_status(entry("a", [], "unhelpful", 1, PROPOSAL)) == "accepted"
    assert server.prefilter_status(entry("a", [], "unhelpful", 2, PROPOSAL)) == "changed"
    assert server.prefilter_status(entry("a", [], "keep", proposal=PROPOSAL)) == "changed"
    assert server.prefilter_status(entry("a", [], "keep")) == "changed"


def test_labels_filter_by_set_and_status(server, labels_file):
    data = server.prefilter_labels({"set": ["train"], "status": ["unchecked"]})
    assert [item["id"] for item in data["items"]] == ["pubmed:2"]
    assert data["items"][0]["status"] == "unchecked"
    assert data["total"] == 1
    assert data["progress"]["train"] == {"checked": 2, "total": 3}
    assert data["progress"]["drops-rules"] == {"checked": 1, "total": 1}
    assert data["guide"] == [{"kind": "k"}]


def test_labels_page_through_all_sets(server, labels_file):
    data = server.prefilter_labels({"limit": ["2"], "offset": ["1"]})
    assert [item["id"] for item in data["items"]] == ["pubmed:2", "pubmed:3"]
    assert data["total"] == 4


def test_labels_filter_by_the_label_that_counts(server, labels_file):
    def ids(label):
        return [item["id"] for item in server.prefilter_labels({"label": [label]})["items"]]

    assert ids("keep") == ["pubmed:1"]
    assert ids("unhelpful") == ["pubmed:2", "pubmed:4"]  # pubmed:2 by its proposal
    assert ids("none") == ["pubmed:3"]
    with pytest.raises(ValueError):
        server.prefilter_labels({"label": ["maybe"]})


def test_pipeline_reports_proposals_people_and_the_model(server, labels_file, tmp_path):
    pipeline = server.prefilter_labels({})["pipeline"]
    assert pipeline | {"model": None} == {
        "documents": 4,
        "proposed": 3,
        "by_model": {"m": 3},
        "by_person": 2,
        "model": None,
        "measured_at": None,
        "rules": None,
    }
    model = {"trained_on": 268, "threshold": None, "below_threshold": 0, "weights": [1.0]}
    (tmp_path / "model.json").write_text(json.dumps(model))
    assert server.prefilter_labels({})["pipeline"]["model"] == {
        "trained_on": 268,
        "threshold": None,
        "below_threshold": 0,
    }


def test_labels_refuse_an_unknown_status(server, labels_file):
    with pytest.raises(ValueError):
        server.prefilter_labels({"status": ["maybe"]})


def test_missing_labels_file_answers_missing(server):
    assert server.prefilter_labels({}) == {"missing": True}


def stored(path):
    return {item["id"]: item for item in json.loads(path.read_text())["documents"]}


@pytest.mark.parametrize(
    "body",
    [
        {"id": "pubmed:2", "label": "unhelpful", "group": None},
        {"id": "pubmed:2", "label": "keep", "group": 1},
        {"id": "pubmed:2", "label": "maybe", "group": None},
        {"id": "pubmed:2", "label": "keep", "group": None, "note": "x" * 501},
        {"id": "pubmed:2", "label": "keep", "group": None, "note": 5},
    ],
)
def test_save_label_validates(server, labels_file, body):
    with pytest.raises(ValueError):
        server.save_prefilter_label(body)
    assert stored(labels_file)["pubmed:2"]["label"] is None


def test_save_label_refuses_an_unknown_document(server, labels_file):
    with pytest.raises(LookupError):
        server.save_prefilter_label({"id": "pubmed:404", "label": "keep", "group": None})


def test_save_label_keeps_the_proposal(server, labels_file):
    body = {"id": "pubmed:2", "label": "keep", "group": None, "note": "trial"}
    saved = server.save_prefilter_label(body)
    assert saved["status"] == "changed" and saved["checked_at"]
    entry = stored(labels_file)["pubmed:2"]
    assert (entry["label"], entry["note"], entry["proposal"]) == ("keep", "trial", PROPOSAL)
    assert not [p.name for p in labels_file.parent.iterdir() if p.suffix == ".tmp"]


def test_parallel_saves_keep_both_labels(server, labels_file):
    original = server.prefilter_write

    def slow_write(path, data):  # widen the window between reading and writing
        time.sleep(0.05)
        original(path, data)

    server.prefilter_write = slow_write
    threads = [
        threading.Thread(
            target=server.save_prefilter_label,
            args=({"id": document_id, "label": "keep", "group": None},),
        )
        for document_id in ("pubmed:2", "pubmed:3")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    entries = stored(labels_file)
    assert entries["pubmed:2"]["label"] == entries["pubmed:3"]["label"] == "keep"


def test_results_come_from_the_results_file(server, tmp_path):
    assert server.prefilter_results() == {"missing": True}
    (tmp_path / "results.json").write_text(json.dumps({"total": 3}))
    assert server.prefilter_results() == {"total": 3}


def test_save_waits_for_the_lock_the_script_holds(server, labels_file):
    import fcntl

    lock = open(labels_file.parent / ".labels.lock", "a")  # noqa: SIM115 — the script's lock
    fcntl.flock(lock, fcntl.LOCK_EX)
    done = threading.Event()
    body = {"id": "pubmed:2", "label": "keep", "group": None}
    thread = threading.Thread(target=lambda: (server.save_prefilter_label(body), done.set()))
    thread.start()
    assert not done.wait(0.2)
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
    assert done.wait(2)
    assert stored(labels_file)["pubmed:2"]["label"] == "keep"


@pytest.mark.parametrize("group", [True, 1.0, "1"])
def test_save_label_takes_only_whole_number_groups(server, labels_file, group):
    with pytest.raises(ValueError):
        server.save_prefilter_label({"id": "pubmed:2", "label": "unhelpful", "group": group})


# ── The drop list (#92): listing, decisions and the index version ──
import asyncio  # noqa: E402

import asyncpg  # noqa: E402
from test_prefilter import doc, execute, fetch, insert  # noqa: E402


def on(url, call):
    """`call(connection)` on a writable connection to the test schema."""

    async def main():
        connection = await asyncpg.connect(url)
        try:
            return await call(connection)
        finally:
            await connection.close()

    return asyncio.run(main())


def propose(url, *ids):
    asyncio.run(
        execute(
            url,
            "INSERT INTO document_drops (document_id, proposed_by, reason)"
            " SELECT unnest($1::text[]), 'rule:erratum', 'Notice of an erratum'",
            list(ids),
        )
    )


def drops(url):
    rows = asyncio.run(fetch(url, "SELECT * FROM document_drops ORDER BY document_id"))
    return {row["document_id"]: dict(row) for row in rows}


@pytest.mark.postgres
def test_drops_list_filters_by_status_and_skips_deleted_documents(server, url):
    insert(url, doc("pubmed:1"), doc("pubmed:2"), doc("pubmed:3"))
    propose(url, "pubmed:1", "pubmed:2", "pubmed:3")
    asyncio.run(
        execute(url, "UPDATE document_drops SET status = 'accepted' WHERE document_id = 'pubmed:2'")
    )
    asyncio.run(execute(url, "DELETE FROM documents WHERE id = 'pubmed:3'"))

    listed = on(url, lambda c: server.prefilter_drops(c, {}))
    assert [item["id"] for item in listed["items"]] == ["pubmed:1"]
    assert listed["items"][0]["title"] == "Title pubmed:1"
    assert listed["items"][0]["reason"] == "Notice of an erratum"
    assert listed["total"] == 1
    assert listed["counts"] == {"proposed": 1, "accepted": 1, "rejected": 0}
    assert listed["proposers"] == ["rule:erratum"]
    accepted = on(url, lambda c: server.prefilter_drops(c, {"status": ["accepted"]}))
    assert [item["id"] for item in accepted["items"]] == ["pubmed:2"]


@pytest.mark.postgres
def test_accept_reject_undo_set_effect_at_only_when_indexing_changes(server, url):
    insert(url, doc("pubmed:1"), doc("pubmed:2"))
    propose(url, "pubmed:1", "pubmed:2")

    def save(ids, decision):
        body = {"ids": ids, "decision": decision}
        return on(url, lambda c: server.save_prefilter_drops(c, body))

    assert save(["pubmed:1"], "accept")["changed"] == 1
    assert save(["pubmed:2"], "reject")["changed"] == 1
    rows = drops(url)
    assert rows["pubmed:1"]["status"] == "accepted" and rows["pubmed:1"]["effect_at"]
    assert rows["pubmed:2"]["status"] == "rejected" and rows["pubmed:2"]["effect_at"] is None

    # "Keep" on a page must not undo an accepted drop.
    assert save(["pubmed:1"], "reject")["changed"] == 0
    assert drops(url)["pubmed:1"]["status"] == "accepted"

    assert save(["pubmed:1", "pubmed:2", "pubmed:404"], "undo")["changed"] == 2
    after = drops(url)
    assert after["pubmed:1"]["status"] == "proposed"
    assert after["pubmed:1"]["effect_at"] > rows["pubmed:1"]["effect_at"]
    assert after["pubmed:2"]["status"] == "proposed" and after["pubmed:2"]["effect_at"] is None


@pytest.mark.postgres
def test_version_follows_an_accepted_drop_like_the_matcher(server, url):
    insert(url, doc("pubmed:1"))
    propose(url, "pubmed:1")
    asyncio.run(
        execute(
            url,
            "UPDATE document_drops SET status = 'accepted', effect_at = now() + interval '1 hour'",
        )
    )

    async def versions(connection):
        await server.note_drops_table(connection)
        return await connection.fetchrow(
            f"SELECT {server.version('d')} AS version, d.changed_at, dr.effect_at"
            " FROM documents d JOIN document_drops dr ON dr.document_id = d.id"
        )

    row = on(url, versions)
    assert row["version"] == row["effect_at"] > row["changed_at"]


@pytest.mark.postgres
def test_drops_without_the_table(server, url):
    asyncio.run(execute(url, "DROP TABLE document_drops"))
    insert(url, doc("pubmed:1"))
    assert on(url, lambda c: server.prefilter_drops(c, {})) == {"missing": True}
    with pytest.raises(RuntimeError, match="05-document-drops.sql"):
        on(
            url,
            lambda c: server.save_prefilter_drops(c, {"ids": ["pubmed:1"], "decision": "accept"}),
        )

    async def version(connection):
        await server.note_drops_table(connection)
        return await connection.fetchval(f"SELECT {server.version('d')} FROM documents d")

    assert on(url, version) is not None


@pytest.mark.parametrize(
    "body",
    [
        {"ids": ["pubmed:1"], "decision": "maybe"},
        {"ids": [], "decision": "accept"},
        {"ids": ["x"] * 501, "decision": "accept"},
        {"ids": "pubmed:1", "decision": "accept"},
        {"ids": ["pubmed:1"], "decision": "accept", "note": "x" * 501},
    ],
)
def test_save_drops_refuses_bad_bodies(server, body):
    with pytest.raises(ValueError):
        asyncio.run(server.save_prefilter_drops(None, body))


@pytest.mark.postgres
def test_accept_never_overrides_a_keep(server, url):
    insert(url, doc("pubmed:1"))
    propose(url, "pubmed:1")
    body = {"ids": ["pubmed:1"], "decision": "reject"}
    on(url, lambda c: server.save_prefilter_drops(c, body))
    stale = {"ids": ["pubmed:1"], "decision": "accept"}
    assert on(url, lambda c: server.save_prefilter_drops(c, stale)) == {
        "changed": 0,
        "statuses": {"pubmed:1": "rejected"},
    }
    assert drops(url)["pubmed:1"]["effect_at"] is None


@pytest.mark.postgres
def test_effect_at_moves_forward_even_if_the_clock_went_back(server, url):
    insert(url, doc("pubmed:1"))
    propose(url, "pubmed:1")
    later = "now() + interval '1 hour'"
    asyncio.run(execute(url, f"UPDATE document_drops SET status = 'accepted', effect_at = {later}"))
    before = drops(url)["pubmed:1"]["effect_at"]
    body = {"ids": ["pubmed:1"], "decision": "undo"}
    on(url, lambda c: server.save_prefilter_drops(c, body))
    assert drops(url)["pubmed:1"]["effect_at"] > before
