# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "asyncpg==0.32.0",
#   "huggingface-hub==0.36.2",
#   "numpy==2.5.4",
#   "scikit-learn==1.9.1",
#   "torch==2.9.1",
#   "transformers==4.57.3",
# ]
#
# # The default build for Linux on x86-64 brings NVIDIA's libraries, which are not open source.
# [tool.uv.sources]
# torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux' and platform_machine == 'x86_64'" }]  # noqa: E501
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""The document pre-filter study (#92): can rules and a small classifier drop unhelpful documents?

    uv run --locked scripts/prefilter.py sample --set train
    uv run --locked scripts/prefilter.py propose --set train
    uv run --locked scripts/prefilter.py train
    uv run --locked scripts/prefilter.py measure

Reads `DATABASE_URL` (or `--database-url`) and only reads: every connection is read only. Writes
the labels, the classifier and the results to research/prefilter/. The label a local LLM
proposes counts unless a person changed it in the Pre-filter screen of the debug UI. Method and
results: research/document-prefilter.md.
"""

import argparse
import asyncio
import hashlib
import json
import math
import os
import random
import tempfile
import time
from collections.abc import Callable, Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "research/prefilter/labels.json"
MODEL = ROOT / "research/prefilter/model.json"
RESULTS = ROOT / "research/prefilter/results.json"
# The Qwen index of the AI approach on the VM; the name holds a hash of its settings, so it can
# differ on another machine (--embeddings).
EMBEDDINGS = "ai_summary.qwen_c090b2ac8c6c4a46"

# Where the line for group 1 ("not usable for patients") is; agreed on #92. In doubt, keep.
GUIDE = [
    {
        "kind": "Pure lab or animal work: cell lines, mice, molecular mechanisms",
        "label": "unhelpful",
        "example": "Altered glycosylation in prostate cancer",
    },
    {
        "kind": "Pure methods or statistics papers",
        "label": "unhelpful",
        "example": "a new scoring algorithm",
    },
    {
        "kind": "Clinician work topics",
        "label": "unhelpful",
        "example": "Intraoperative workload of the surgeon in robot-assisted prostatectomy",
    },
    {
        "kind": "Regional statistics",
        "label": "keep",
        "example": "Radical prostatectomy trends 2010-2020 in Ehime, Japan",
    },
    {
        "kind": "Rare patient subgroups",
        "label": "keep",
        "example": "Radical prostatectomy outcomes in renal transplant recipients",
    },
    {
        "kind": "Lab work about a drug patients take",
        "label": "keep",
        "example": "Non-coding RNAs in enzalutamide resistance",
    },
    {
        "kind": "No abstract, but the title shows a useful paper",
        "label": "keep",
        "example": "Metformin and lifestyle modification in polycystic ovary syndrome: review",
    },
]


SHORT_SUMMARY = 200
NO_SUMMARY = "(d.summary IS NULL OR btrim(d.summary) = '')"
SHORT = f"length(btrim(d.summary)) BETWEEN 1 AND {SHORT_SUMMARY - 1}"
NO_FULL_TEXT = "jsonb_array_length(d.full_text) = 0"
# Each rule is an SQL condition on `documents d`; a document is dropped when one of RULE_SET holds.
RULES = {
    "no_summary": NO_SUMMARY,
    "short_summary": SHORT,
    "erratum": (
        "(d.publication_types && ARRAY['Erratum', 'Published Erratum']"
        r" OR d.title ~* '^(correction to|erratum|corrigendum)\M')"
    ),
    "reaction_without_abstract": (
        "(d.publication_types && ARRAY['Editorial', 'Comment', 'Letter']"
        f" AND (d.summary IS NULL OR length(btrim(d.summary)) < {SHORT_SUMMARY}))"
    ),
    # Variants, only reported. A missing or short summary alone drops too many documents people
    # keep (#92); the keyword index may still read a full text of these.
    "no_summary_no_full_text": f"({NO_SUMMARY} AND {NO_FULL_TEXT})",
    "short_summary_no_full_text": f"({SHORT} AND {NO_FULL_TEXT})",
}
RULE_SET = ["erratum", "reaction_without_abstract"]
ANY_RULE = "(" + " OR ".join(RULES[rule] for rule in RULE_SET) + ")"


async def rule_hits(connection: Any, rule: str, limit: int, seed: float) -> list[str]:
    """Up to `limit` random ids of documents that `rule` drops; the same `seed`, the same ids."""
    await connection.execute("SELECT setseed($1)", seed)
    rows = await connection.fetch(
        f"SELECT d.id FROM documents d WHERE {RULES[rule]} ORDER BY random() LIMIT $1", limit
    )
    return [row["id"] for row in rows]


async def rule_counts(connection: Any) -> dict[str, Any]:
    """Per rule, then per source, how many documents it drops; `_all` is any rule of RULE_SET,
    `_total` every document, and `_seconds` how long each query took."""

    async def per_source(condition: str) -> tuple[dict[str, int], float]:
        started = time.perf_counter()
        rows = await connection.fetch(
            f"SELECT d.source, count(*) AS n FROM documents d WHERE {condition}"
            " GROUP BY d.source ORDER BY d.source"
        )
        return {row["source"]: row["n"] for row in rows}, time.perf_counter() - started

    counts: dict[str, Any] = {"_seconds": {}}
    for name, condition in [*RULES.items(), ("_all", ANY_RULE)]:
        counts[name], counts["_seconds"][name] = await per_source(condition)
    counts["_total"], _ = await per_source("true")
    return counts


JUDGMENTS = ROOT / "matcher/evaluation/keyword-llm-judgments.json"
LAB_TITLE = r"\m(mice|mouse|murine|rat|rats|cell line|cell lines|in vitro|xenograft)\M"


async def connect(url: str) -> Any:
    """A connection that cannot write: the study only reads, also on the VM."""
    import asyncpg

    return await asyncpg.connect(url, server_settings={"default_transaction_read_only": "on"})


def never_above_one(path: Path = JUDGMENTS) -> list[str]:
    """The documents that the LLM grades of #58 never put above 1, for any point."""
    best: dict[str, int] = {}
    for point in json.loads(path.read_text(encoding="utf-8"))["points"].values():
        for grade, ids in point["grades"].items():
            for document_id in ids.split():
                best[document_id] = max(best.get(document_id, 0), int(grade))
    return sorted(document_id for document_id, grade in best.items() if grade <= 1)


async def random_ids(
    connection: Any, condition: str, limit: int, exclude: list[str], *args: Any
) -> list[str]:
    """Random ids of documents that meet `condition` and are not in `exclude`."""
    if limit <= 0:
        return []
    rows = await connection.fetch(
        f"SELECT d.id FROM documents d WHERE ({condition}) AND NOT d.id = ANY($1::text[])"
        f" ORDER BY random() LIMIT $2",
        exclude,
        limit,
        *args,
    )
    return [row["id"] for row in rows]


async def sample_train(
    connection: Any, n: int = 500, seed: float = 0.42, exclude: Iterable[str] = ()
) -> list[str]:
    """Training candidates, enriched for unhelpful documents: 40% random, 20% rule hits spread
    over RULE_SET, 25% never above 1 in #58, 15% lab titles; a short group is filled at random.
    Documents in `exclude` (those already in the labels file) are never picked again."""
    await connection.execute("SELECT setseed($1)", seed)
    known = list(exclude)
    chosen: list[str] = []
    per_rule = round(n * 0.20) // len(RULE_SET)
    for rule in RULE_SET:
        chosen += await random_ids(connection, RULES[rule], per_rule, known + chosen)
    taken = set(known + chosen)
    weak = [i for i in never_above_one() if i not in taken]
    chosen += await random_ids(
        connection, "d.id = ANY($3::text[])", round(n * 0.25), known + chosen, weak
    )
    chosen += await random_ids(
        connection, "d.title ~* $3", round(n * 0.15), known + chosen, LAB_TITLE
    )
    chosen += await random_ids(connection, "true", n - len(chosen), known + chosen)
    return chosen[:n]


async def sample_low_score(
    connection: Any,
    model: dict[str, Any],
    table: str,
    n: int,
    exclude: Iterable[str],
    seed: float = 0.46,
    pool: int = 20,
) -> list[str]:
    """The `n` documents the classifier is surest to drop, out of a random pool of `pool` times
    as many embedded documents that the rules keep and nobody has labeled yet: more labels where
    the threshold is decided."""
    await check_table(connection, table)
    await connection.execute("SELECT setseed($1)", seed)
    rows = await connection.fetch(
        f"SELECT d.id, e.embedding::text AS vector FROM {table} e"
        f" JOIN documents d ON d.id = e.document_id"
        f" WHERE e.embedding IS NOT NULL AND NOT {ANY_RULE} AND NOT d.id = ANY($1::text[])"
        " ORDER BY random() LIMIT $2",
        list(exclude),
        n * pool,
    )
    vectors = ((row["id"], json.loads(row["vector"])) for row in rows)
    scored = sorted(score_rows(vectors, model["weights"], model["bias"]), key=lambda x: x[1])
    return [document_id for document_id, _ in scored[:n]]


async def sample_random(connection: Any, n: int = 300, seed: float = 0.43) -> list[str]:
    """A uniform random sample of the whole table, for the share of unhelpful documents."""
    await connection.execute("SELECT setseed($1)", seed)
    return await random_ids(connection, "true", n, [])


PROMPT_SUMMARY = 4000
DEFINITION = """\
You sort documents for an app that shows patients research papers, videos and podcasts that fit
their situation. Decide if a document is UNHELPFUL for every patient, with any disease:

Group 1, not usable for patients: lab research (cell lines, molecular mechanisms only), animal
studies, pure methods or statistics papers, work written only for clinicians or researchers.
Group 2, little information: errata, corrections, letters, comments and editorials that only
react to another paper, and documents whose title and summary say nothing usable.

A good document for some patients is not unhelpful, even if it fits few of them. A missing
summary alone does not make a document unhelpful.
In doubt, keep."""


def build_prompt(document: dict[str, Any], guide: list[dict[str, str]]) -> str:
    rows = "\n".join(f"- {row['kind']}: {row['label']} (e.g. {row['example']})" for row in guide)
    summary = (document.get("summary") or "").strip()[:PROMPT_SUMMARY] or "(none)"
    types = ", ".join(document.get("publication_types") or []) or "(none)"
    return (
        f"{DEFINITION}\n\nExamples:\n{rows}\n\n"
        f"Title: {document.get('title')}\n"
        f"Source: {document.get('source')}, {document.get('content_type')}\n"
        f"Publication types: {types}\n"
        f"Summary: {summary}\n\n"
        'Answer with one JSON object only: {"label": "unhelpful" or "keep",'
        ' "group": 1 or 2 when unhelpful, else null, "reason": "<one sentence>"}'
    )


def parse_answer(text: str) -> dict[str, Any] | None:
    """The first JSON object of a model answer, if it is a valid label; else None."""
    start = text.find("{")
    if start < 0:
        return None
    try:
        answer, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError:
        return None
    if not isinstance(answer, dict):
        return None
    label, group, reason = answer.get("label"), answer.get("group"), answer.get("reason")
    whole = type(group) is int and group in (1, 2)  # not true or 1.0, which JSON also allows
    valid = (label == "unhelpful" and whole) or (label == "keep" and group is None)
    if not valid or not isinstance(reason, str) or not reason.strip():
        return None
    return {"label": label, "group": group, "reason": reason.strip()}


def load_labels(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "guide": GUIDE, "documents": []}
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def save_labels(path: Path, data: dict[str, Any]) -> None:
    """Write through a temporary file, so a crash never leaves half a labels file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
    ) as file:
        json.dump(data, file, indent=2, ensure_ascii=False)
        file.write("\n")
    os.replace(file.name, path)


def lock_path(path: Path) -> Path:
    """The lock that this script and the Pre-filter screen of the debug UI both take."""
    return path.with_name(f".{path.stem}.lock")


def update_labels[T](path: Path, change: Callable[[dict[str, Any]], T]) -> T:
    """Apply `change` to the labels file as it is on disk now, under the shared lock, so a label
    a person saved in the debug UI meanwhile is never written over."""
    import fcntl

    path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path(path), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            data = load_labels(path)
            result = change(data)
            save_labels(path, data)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    return result


def add_documents(data: dict[str, Any], ids: Iterable[str], set_name: str) -> int:
    """Put `ids` into `set_name`; labels, notes and proposals of known ids stay as they are."""
    known = {entry["id"]: entry for entry in data["documents"]}
    added = 0
    for document_id in ids:
        entry = known.get(document_id)
        if entry is None:
            entry = {
                "id": document_id,
                "sets": [],
                "proposal": None,
                "proposal_raw": None,
                "label": None,
                "group": None,
                "note": "",
                "checked_at": None,
            }
            data["documents"].append(entry)
            known[document_id] = entry
            added += 1
        if set_name not in entry["sets"]:
            entry["sets"].append(set_name)
    return added


def label_of(entry: dict[str, Any]) -> str | None:
    """The label a person gave, else the label the LLM proposed, else None."""
    if entry["label"] is not None:
        return entry["label"]
    return entry["proposal"]["label"] if entry["proposal"] else None


def group_of(entry: dict[str, Any]) -> int | None:
    """The group that belongs to `label_of(entry)`."""
    if entry["label"] is not None:
        return entry["group"]
    return entry["proposal"]["group"] if entry["proposal"] else None


def labeled(data: dict[str, Any], set_name: str) -> list[dict[str, Any]]:
    """The entries of a set with a label, from a person or from the LLM."""
    return [
        entry
        for entry in data["documents"]
        if set_name in entry["sets"] and label_of(entry) is not None
    ]


def upper_bound(wrong: int, checked: int, confidence: float = 0.95) -> float:
    """One-sided Clopper-Pearson upper bound of the share of wrong drops."""
    if checked == 0:
        return 1.0
    if wrong >= checked:
        return 1.0

    def at_most_wrong(p: float) -> float:
        return sum(
            math.comb(checked, k) * p**k * (1 - p) ** (checked - k) for k in range(wrong + 1)
        )

    low, high = wrong / checked, 1.0
    for _ in range(100):
        middle = (low + high) / 2
        if at_most_wrong(middle) > 1 - confidence:
            low = middle
        else:
            high = middle
    return high


def passes_safety(wrong: int, checked: int, minimum: int = 300) -> bool:
    """The safety bar of #92: enough checked drops and at most 1 wrong one."""
    return checked >= minimum and wrong <= 1


def choose_threshold(
    scores: list[tuple[float, str]], max_wrong: float = 0.01, min_below: int = 100
) -> float | None:
    """The largest cut-off on the probability of `keep` that drops safely.

    `scores` are (out-of-fold probability of keep, label). Documents with a score below the
    cut-off are dropped; at least `min_below` must be, and at most `max_wrong` of them `keep`.
    """
    ordered = sorted(scores)
    best = None
    keep = 0
    for index, (score, label) in enumerate(ordered):
        below = index  # with the tie check below, every earlier document scores lower
        if (
            below >= min_below
            and keep / below <= max_wrong
            and (index == 0 or ordered[index - 1][0] < score)
        ):
            best = score
        keep += label == "keep"
    return best


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cli.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    commands = cli.add_subparsers(dest="command", required=True)
    sample = commands.add_parser("sample", help="add a sample of documents to the labels file")
    sample.add_argument("--set", choices=["train", "random"], required=True)
    sample.add_argument("--n", type=int)
    sample.add_argument("--seed", type=float, help="between -1 and 1; another seed, another sample")
    sample.add_argument(
        "--low-score",
        action="store_true",
        help="documents the classifier is surest to drop, to label more near its threshold",
    )
    sample.add_argument("--embeddings", default=EMBEDDINGS, help="table of the AI index")
    propose = commands.add_parser("propose", help="let a local LLM propose labels")
    propose.add_argument("--set")
    propose.add_argument("--limit", type=int)
    imports = commands.add_parser(
        "import-proposals", help="merge proposals another labeler wrote, one JSON per line"
    )
    imports.add_argument("file", type=Path)
    imports.add_argument("--model", required=True, help="who proposed them, e.g. codex")
    train = commands.add_parser("train", help="train the classifier on the training labels")
    measure = commands.add_parser("measure", help="measure drops, safety and speed")
    for command in (train, measure):
        command.add_argument("--embeddings", default=EMBEDDINGS, help="table of the AI index")
    return cli


async def sample(
    url: str,
    set_name: str,
    n: int | None,
    seed: float | None = None,
    low_score: bool = False,
    table: str = EMBEDDINGS,
) -> None:
    known = [entry["id"] for entry in load_labels(LABELS)["documents"]]
    model = json.loads(MODEL.read_text(encoding="utf-8")) if MODEL.exists() else None
    if low_score and model is None:
        raise SystemExit("--low-score needs a classifier: run train first")
    connection = await connect(url)
    try:
        if low_score:
            ids = await sample_low_score(connection, model or {}, table, n or 200, known)
        elif set_name == "train":
            ids = await sample_train(connection, n or 500, seed or 0.42, known)
        else:
            ids = await sample_random(connection, n or 300, seed or 0.43)
    finally:
        await connection.close()
    added = update_labels(LABELS, lambda data: add_documents(data, ids, set_name))
    print(f"{set_name}: {added} new documents, {len(ids)} in this sample")


async def check_table(connection: Any, table: str) -> None:
    if await connection.fetchval("SELECT to_regclass($1)", table) is None:
        raise SystemExit(f"No table {table}: build the AI index first, or pass --embeddings")


async def embeddings(
    connection: Any, ids: list[str], table: str = EMBEDDINGS
) -> dict[str, list[float]]:
    """The stored vectors of `ids`; documents without one, or with a NULL one, are left out."""
    await check_table(connection, table)
    rows = await connection.fetch(
        f"SELECT document_id, embedding::text AS vector FROM {table}"
        " WHERE document_id = ANY($1::text[]) AND embedding IS NOT NULL",
        ids,
    )
    return {row["document_id"]: json.loads(row["vector"]) for row in rows}


def keep_probability(weights: list[float], bias: float, vector: list[float]) -> float:
    """The classifier's probability that a document should be kept; plain Python, no numpy."""
    score = bias + sum(w * x for w, x in zip(weights, vector, strict=True))
    if score < -700:
        return 0.0
    return 1 / (1 + math.exp(-score))


def score_rows(
    rows: Iterable[tuple[str, list[float] | None]], weights: list[float], bias: float
) -> Iterator[tuple[str, float]]:
    """(id, probability of keep) for rows with a vector; the others cannot be judged."""
    for document_id, vector in rows:
        if vector is not None:
            yield document_id, keep_probability(weights, bias, vector)


def fit(vectors: list[list[float]], labels: list[str]) -> tuple[list[float], float, list[float]]:
    """Logistic regression for `keep`: weights, bias, and the out-of-fold probability of keep of
    every input (5 stratified folds), which the threshold is chosen on."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_predict

    targets = [label == "keep" for label in labels]
    classifier = LogisticRegression(class_weight="balanced", max_iter=2000)
    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
    out_of_fold = cross_val_predict(classifier, vectors, targets, cv=folds, method="predict_proba")
    classifier.fit(vectors, targets)
    # The classes are [False, True], so coef_ and the second column are those of keep.
    return (
        [float(w) for w in classifier.coef_[0]],
        float(classifier.intercept_[0]),
        [float(row[1]) for row in out_of_fold],
    )


def labels_hash(entries: Iterable[dict[str, Any]]) -> str:
    """Which labels a classifier was trained on; a change makes the model stale."""
    pairs = sorted((entry["id"], label_of(entry)) for entry in entries)
    return hashlib.sha256(json.dumps(pairs).encode()).hexdigest()


async def rule_dropped(connection: Any, ids: list[str]) -> set[str]:
    rows = await connection.fetch(
        f"SELECT d.id FROM documents d WHERE d.id = ANY($1::text[]) AND {ANY_RULE}", ids
    )
    return {row["id"] for row in rows}


async def train(url: str, table: str = EMBEDDINGS) -> None:
    """Fit on the training labels of documents the rules keep, and fix the threshold."""
    entries = labeled(load_labels(LABELS), "train")
    ids = [entry["id"] for entry in entries]
    connection = await connect(url)
    try:
        dropped = await rule_dropped(connection, ids)
        vectors = await embeddings(connection, ids, table)
    finally:
        await connection.close()
    used = [e for e in entries if e["id"] not in dropped and e["id"] in vectors]
    targets = [label_of(e) for e in used]
    weights, bias, out_of_fold = fit([vectors[e["id"]] for e in used], targets)
    threshold = choose_threshold(list(zip(out_of_fold, targets, strict=True)))
    below = 0 if threshold is None else sum(score < threshold for score in out_of_fold)
    model = {
        "weights": weights,
        "bias": bias,
        "threshold": threshold,
        "trained_on": len(used),
        "by_person": sum(e["label"] is not None for e in used),
        "below_threshold": below,
        "labels_hash": labels_hash(entries),
        "embeddings": table,
    }
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    MODEL.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    print(f"trained on {len(used)}; threshold {threshold}, {below} training documents below it")
    if threshold is None:
        print("No safe threshold yet: label more candidates with low scores, then train again")


def model_drop_set(model: dict[str, Any]) -> str:
    """The set of checked drops of one classifier: a retrained one gets a sample of its own."""
    return f"drops-model:{model.get('labels_hash', '')[:8]}"


def add_drop_samples(
    data: dict[str, Any],
    rule_drops: list[str],
    model_drops: list[str],
    per_rule: dict[str, list[str]],
    model_set: str = "drops-model",
) -> None:
    """Add the samples of drops to check, each set only once: a later run must not change a
    sample that people already checked."""
    filled = {name for entry in data["documents"] for name in entry["sets"]}
    samples = {"drops-rules": rule_drops, model_set: model_drops}
    samples |= {f"drops-rule:{rule}": ids for rule, ids in per_rule.items()}
    for name, ids in samples.items():
        if name not in filled and ids:
            add_documents(data, ids, name)


def drop_checks(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Labeled drops, the wrong ones among them (labeled keep) and the safety bar."""
    entries = [entry for entry in entries if label_of(entry) is not None]
    labels = [label_of(entry) for entry in entries]
    wrong = labels.count("keep")
    return {
        "checked": len(labels),
        "by_person": sum(entry["label"] is not None for entry in entries),
        "wrong": wrong,
        "upper_bound": upper_bound(wrong, len(labels)),
        "safe": passes_safety(wrong, len(labels)),
    }


def approach(
    dropped: int, by_source: dict[str, int], total: int, checks: dict[str, Any], safe: bool
) -> dict[str, Any]:
    share = dropped / total if total else 0.0
    return {
        "dropped": dropped,
        "share": share,
        "by_source": by_source,
        "checked": checks["checked"],
        "by_person": checks["by_person"],
        "wrong": checks["wrong"],
        "upper_bound": checks["upper_bound"],
        "passes": {"safety": safe, "usefulness_2": share >= 0.02, "usefulness_3": share >= 0.03},
    }


def agreement(proposed: list[dict[str, Any]]) -> dict[str, Any]:
    """How often a person kept the proposed label, overall and per model that proposed it."""

    def count(entries: list[dict[str, Any]]) -> dict[str, int]:
        agreed = sum(entry["proposal"]["label"] == entry["label"] for entry in entries)
        return {"checked": len(entries), "agreed": agreed}

    models: dict[str, list[dict[str, Any]]] = {}
    for entry in proposed:
        models.setdefault(entry["proposal"].get("model", "?"), []).append(entry)
    return count(proposed) | {"by_model": {name: count(group) for name, group in models.items()}}


def summarize(
    labels: dict[str, Any],
    counts: dict[str, Any],
    model: dict[str, Any] | None,
    scored: dict[str, Any],
    timing: dict[str, Any],
    hits: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """The results file: drops per approach and rule, their checked samples, the model, the
    LLM's agreement with people and the share of unhelpful documents in the random sample."""
    hits = hits or {}
    documents = labels["documents"]

    def in_set(name: str) -> list[dict[str, Any]]:
        return [entry for entry in documents if name in entry["sets"]]

    totals, all_rules = counts.get("_total", {}), counts.get("_all", {})
    total = sum(totals.values())
    rule_checks = drop_checks(in_set("drops-rules"))
    rules = approach(sum(all_rules.values()), all_rules, total, rule_checks, rule_checks["safe"])

    combined = None
    if model is not None and model.get("threshold") is not None:
        embedded, model_dropped = scored.get("embedded", {}), scored.get("dropped", {})
        by_source = dict(all_rules)
        cannot_judge = 0
        for source, n in totals.items():
            kept = n - all_rules.get(source, 0)
            seen = embedded.get(source, 0)
            cannot_judge += kept - seen
            extra = round(model_dropped.get(source, 0) * kept / seen) if seen else 0
            by_source[source] = by_source.get(source, 0) + extra
        model_checks = drop_checks(in_set(model_drop_set(model)))
        safe = rule_checks["safe"] and model_checks["safe"]
        combined = approach(sum(by_source.values()), by_source, total, model_checks, safe)
        combined |= {"cannot_judge": cannot_judge, "extrapolated": True}

    per_rule = {}
    for name in RULES:
        mine = [
            entry
            for entry in in_set("drops-rules") + in_set(f"drops-rule:{name}")
            if name in hits.get(entry["id"], [])
        ]
        checks = drop_checks({entry["id"]: entry for entry in mine}.values())
        per_rule[name] = {
            "dropped": sum(counts.get(name, {}).values()),
            "by_source": counts.get(name, {}),
            "checked": checks["checked"],
            "wrong": checks["wrong"],
            "seconds": counts.get("_seconds", {}).get(name),
            "variant": name not in RULE_SET,
        }

    with_label = [entry for entry in documents if label_of(entry) is not None]
    proposed = [e for e in documents if e["label"] is not None and e["proposal"] is not None]
    random_checked = [entry for entry in in_set("random") if label_of(entry) is not None]
    unhelpful = [entry for entry in random_checked if label_of(entry) == "unhelpful"]
    return {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "labels_hash": labels_hash(with_label),
        "total": total,
        "approaches": {"rules": rules, "rules+model": combined},
        "rules": per_rule,
        "model": None
        if model is None
        else {
            "threshold": model.get("threshold"),
            "trained_on": model.get("trained_on"),
            "by_person": model.get("by_person"),
            "below_threshold": model.get("below_threshold"),
            "stale": labels_hash(labeled(labels, "train")) != model.get("labels_hash"),
        },
        "llm_agreement": agreement(proposed),
        "random": {
            "checked": len(random_checked),
            "by_person": sum(entry["label"] is not None for entry in random_checked),
            "unhelpful": len(unhelpful),
            "by_group": {g: sum(str(group_of(e)) == g for e in unhelpful) for g in ("1", "2")},
        },
        "timing": timing,
    }


DROP_SAMPLE = 300
RULE_SAMPLE = 30


async def hits_of(connection: Any, ids: list[str]) -> dict[str, list[str]]:
    """Which rules drop each of `ids`."""
    cases = ", ".join(
        f"CASE WHEN {condition} THEN '{name}' END" for name, condition in RULES.items()
    )
    rows = await connection.fetch(
        f"SELECT d.id, array_remove(ARRAY[{cases}], NULL) AS rules FROM documents d"
        " WHERE d.id = ANY($1::text[])",
        ids,
    )
    return {row["id"]: list(row["rules"]) for row in rows}


async def score_table(
    connection: Any, model: dict[str, Any], table: str, seed: int = 44
) -> tuple[dict[str, Any], list[str], float]:
    """Score every embedded document the rules keep. Returns the counts per source (embedded,
    dropped), a random sample of the drops and the milliseconds per document of the scoring."""
    await check_table(connection, table)
    embedded: dict[str, int] = {}
    dropped: dict[str, int] = {}
    sample: list[str] = []
    chance = random.Random(seed)
    seconds = 0.0
    n = 0
    async with connection.transaction():
        cursor = connection.cursor(
            f"SELECT d.id, d.source, e.embedding::text AS vector FROM {table} e"
            f" JOIN documents d ON d.id = e.document_id"
            f" WHERE e.embedding IS NOT NULL AND NOT {ANY_RULE}",
            prefetch=5000,
        )
        async for row in cursor:
            vector = json.loads(row["vector"])
            started = time.perf_counter()
            probability = keep_probability(model["weights"], model["bias"], vector)
            seconds += time.perf_counter() - started
            source = row["source"]
            embedded[source] = embedded.get(source, 0) + 1
            n += 1
            if probability < model["threshold"]:
                dropped[source] = dropped.get(source, 0) + 1
                drops = sum(dropped.values())
                if len(sample) < DROP_SAMPLE:  # reservoir sampling: each drop equally likely
                    sample.append(row["id"])
                elif (slot := chance.randrange(drops)) < DROP_SAMPLE:
                    sample[slot] = row["id"]
    return {"embedded": embedded, "dropped": dropped}, sample, seconds * 1000 / n if n else 0.0


async def measure(url: str, table: str = EMBEDDINGS) -> None:
    """Count the drops on the whole table, add the samples of drops to check, write RESULTS."""
    model = json.loads(MODEL.read_text(encoding="utf-8")) if MODEL.exists() else None
    data = load_labels(LABELS)
    known = {name for entry in data["documents"] for name in entry["sets"]}
    connection = await connect(url)
    try:
        counts = await rule_counts(connection)
        scored: dict[str, Any] = {}
        model_drops: list[str] = []
        milliseconds = None
        if model is not None and model.get("threshold") is not None:
            scored, model_drops, milliseconds = await score_table(connection, model, table)
        rule_drops: list[str] = []
        if "drops-rules" not in known:
            await connection.execute("SELECT setseed($1)", 0.45)
            rule_drops = await random_ids(connection, ANY_RULE, DROP_SAMPLE, [])
        model_set = model_drop_set(model) if model else "drops-model"
        add_drop_samples(data, rule_drops, model_drops, {}, model_set)  # on the snapshot, to plan
        sampled = [e["id"] for e in data["documents"] if "drops-rules" in e["sets"]]
        sampled_hits = await hits_of(connection, sampled)
        per_rule = {}
        for rule in RULE_SET:
            have = sum(rule in rules for rules in sampled_hits.values())
            if have < RULE_SAMPLE and f"drops-rule:{rule}" not in known:
                exclude = [entry["id"] for entry in data["documents"]]
                per_rule[rule] = await random_ids(
                    connection, RULES[rule], RULE_SAMPLE - have, exclude
                )
        add_drop_samples(data, [], [], per_rule)
        in_drops = [
            e["id"] for e in data["documents"] if any(s.startswith("drops-") for s in e["sets"])
        ]
        hits = await hits_of(connection, in_drops)
    finally:
        await connection.close()

    def merge(fresh: dict[str, Any]) -> dict[str, Any]:
        add_drop_samples(fresh, rule_drops, model_drops, per_rule, model_set)
        return fresh

    data = update_labels(LABELS, merge)
    timing = {"rules_seconds": counts["_seconds"]["_all"], "model_ms_per_document": milliseconds}
    result = summarize(data, counts, model, scored, timing, hits)
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    RESULTS.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    rules = result["approaches"]["rules"]
    print(f"rules drop {rules['dropped']} of {result['total']} ({rules['share']:.1%})")


PROPOSER = ("Qwen/Qwen3-4B", "1cfa9a7208912126459214e8b04321603b3df60c")


def qwen_generator() -> Callable[[str], str]:
    """The local proposer: non-thinking mode, greedy, at most 128 new tokens; mps if there.

    Eager attention: with the default (SDPA) attention on mps, Qwen3 writes garbage."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    repository, revision = PROPOSER
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(repository, revision=revision)
    model = AutoModelForCausalLM.from_pretrained(
        repository, revision=revision, dtype=torch.bfloat16, attn_implementation="eager"
    ).to(device)

    def generate(prompt: str) -> str:
        text = tokenizer.apply_chat_template(
            [{"role": "user", "content": prompt}],
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        inputs = tokenizer([text], return_tensors="pt").to(device)
        with torch.no_grad():
            output = model.generate(**inputs, max_new_tokens=128, do_sample=False)
        answer = output[0][inputs["input_ids"].shape[1] :]
        return str(tokenizer.decode(answer, skip_special_tokens=True))

    return generate


async def propose(
    url: str, set_name: str | None, limit: int | None, generate: Callable[[str], str]
) -> None:
    """Ask the model about every entry without a proposal or raw answer yet."""
    data = load_labels(LABELS)
    todo = [
        entry
        for entry in data["documents"]
        if entry["proposal"] is None
        and entry["proposal_raw"] is None
        and (set_name is None or set_name in entry["sets"])
    ][:limit]
    connection = await connect(url)
    try:
        rows = await connection.fetch(
            "SELECT id, title, source, content_type, publication_types, summary"
            " FROM documents WHERE id = ANY($1::text[])",
            [entry["id"] for entry in todo],
        )
    finally:
        await connection.close()
    documents = {row["id"]: dict(row) for row in rows}
    model = "{}@{}".format(*PROPOSER)
    answers: dict[str, dict[str, Any]] = {}

    def merge(fresh: dict[str, Any]) -> None:
        """Only the proposals change; labels people saved meanwhile stay as they are."""
        for entry in fresh["documents"]:
            answer = answers.get(entry["id"])
            if answer and entry["proposal"] is None and entry["proposal_raw"] is None:
                entry |= answer
        answers.clear()

    done = empty = 0
    for entry in todo:
        document = documents.get(entry["id"])
        if document is None:
            continue  # no longer stored here; a person can still label it
        answer = generate(build_prompt(document, data["guide"]))
        if not answer.strip():
            empty += 1
            continue  # nothing to check; the next run asks again
        proposal = parse_answer(answer)
        answers[entry["id"]] = (
            {"proposal_raw": answer}
            if proposal is None
            else {"proposal": proposal | {"model": model}}
        )
        done += 1
        if done % 10 == 0:
            update_labels(LABELS, merge)
    update_labels(LABELS, merge)
    print(f"proposed {done}, empty answers {empty}, not stored here {len(todo) - len(documents)}")


def import_proposals(path: Path, model: str) -> dict[str, int]:
    """Merge proposals another labeler wrote (JSON lines of id, label, group, reason) into the
    labels file, under the lock. Only entries without a proposal get one; labels people saved
    stay untouched. Lines that are not a valid label are counted, not merged."""
    report = {"merged": 0, "invalid": 0, "unknown": 0, "already": 0}
    answers: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            report["invalid"] += 1
            continue
        proposal = parse_answer(line) if isinstance(item, dict) else None
        if proposal is None or not isinstance(item.get("id"), str):
            report["invalid"] += 1
            continue
        answers[item["id"]] = proposal | {"model": model}

    def merge(data: dict[str, Any]) -> None:
        known = {entry["id"]: entry for entry in data["documents"]}
        for document_id, proposal in answers.items():
            entry = known.get(document_id)
            if entry is None:
                report["unknown"] += 1
            elif entry["proposal"] is not None:
                report["already"] += 1
            else:
                entry["proposal"] = proposal
                entry["proposal_raw"] = None
                report["merged"] += 1

    update_labels(LABELS, merge)
    return report


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    if args.command == "import-proposals":
        report = import_proposals(args.file, args.model)
        print(", ".join(f"{name} {count}" for name, count in report.items()))
        return
    if not args.database_url:
        raise SystemExit("Set DATABASE_URL or pass --database-url")
    if args.command == "sample":
        asyncio.run(
            sample(args.database_url, args.set, args.n, args.seed, args.low_score, args.embeddings)
        )
    elif args.command == "propose":
        asyncio.run(propose(args.database_url, args.set, args.limit, qwen_generator()))
    elif args.command == "train":
        asyncio.run(train(args.database_url, args.embeddings))
    elif args.command == "measure":
        asyncio.run(measure(args.database_url, args.embeddings))
    else:
        raise SystemExit(f"{args.command}: not implemented")


if __name__ == "__main__":
    main()
