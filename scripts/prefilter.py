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
the labels, the classifier and the results to research/prefilter/. People check the proposed
labels in the Pre-filter screen of the debug UI. Method and results: research/document-prefilter.md.
"""

import argparse
import asyncio
import hashlib
import json
import math
import os
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
    # Variants, only reported: the keyword index may still read a full text of these.
    "no_summary_no_full_text": f"({NO_SUMMARY} AND {NO_FULL_TEXT})",
    "short_summary_no_full_text": f"({SHORT} AND {NO_FULL_TEXT})",
}
RULE_SET = ["no_summary", "short_summary", "erratum", "reaction_without_abstract"]
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


async def sample_train(connection: Any, n: int = 500, seed: float = 0.42) -> list[str]:
    """Training candidates, enriched for unhelpful documents: 40% random, 20% rule hits spread
    over RULE_SET, 25% never above 1 in #58, 15% lab titles; a short group is filled at random."""
    await connection.execute("SELECT setseed($1)", seed)
    chosen: list[str] = []
    per_rule = round(n * 0.20) // len(RULE_SET)
    for rule in RULE_SET:
        chosen += await random_ids(connection, RULES[rule], per_rule, chosen)
    weak = [i for i in never_above_one() if i not in chosen]
    chosen += await random_ids(connection, "d.id = ANY($3::text[])", round(n * 0.25), chosen, weak)
    chosen += await random_ids(connection, "d.title ~* $3", round(n * 0.15), chosen, LAB_TITLE)
    chosen += await random_ids(connection, "true", n - len(chosen), chosen)
    return chosen[:n]


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
Group 2, little information: no or a very short abstract or description, errata, corrections,
letters, comments, editorials.

A good document for some patients is not unhelpful, even if it fits few of them.
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
    valid = (label == "unhelpful" and group in (1, 2)) or (label == "keep" and group is None)
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


def checked(data: dict[str, Any], set_name: str) -> list[dict[str, Any]]:
    """The entries of a set that a person has labeled."""
    return [
        entry
        for entry in data["documents"]
        if set_name in entry["sets"] and entry["label"] is not None
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
    propose = commands.add_parser("propose", help="let a local LLM propose labels")
    propose.add_argument("--set")
    propose.add_argument("--limit", type=int)
    train = commands.add_parser("train", help="train the classifier on the checked training labels")
    measure = commands.add_parser("measure", help="measure drops, safety and speed")
    for command in (train, measure):
        command.add_argument("--embeddings", default=EMBEDDINGS, help="table of the AI index")
    return cli


async def sample(url: str, set_name: str, n: int | None) -> None:
    connection = await connect(url)
    try:
        if set_name == "train":
            ids = await sample_train(connection, n or 500)
        else:
            ids = await sample_random(connection, n or 300)
    finally:
        await connection.close()
    data = load_labels(LABELS)
    added = add_documents(data, ids, set_name)
    save_labels(LABELS, data)
    print(f"{set_name}: {added} new documents, {len(ids)} in this sample")


# The Qwen index of the AI approach on the VM; the name holds a hash of its settings, so it can
# differ on another machine (--embeddings).
EMBEDDINGS = "ai_summary.qwen_c090b2ac8c6c4a46"


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
    """Which checked labels a classifier was trained on; a change makes the model stale."""
    pairs = sorted((entry["id"], entry["label"]) for entry in entries)
    return hashlib.sha256(json.dumps(pairs).encode()).hexdigest()


async def rule_dropped(connection: Any, ids: list[str]) -> set[str]:
    rows = await connection.fetch(
        f"SELECT d.id FROM documents d WHERE d.id = ANY($1::text[]) AND {ANY_RULE}", ids
    )
    return {row["id"] for row in rows}


async def train(url: str, table: str = EMBEDDINGS) -> None:
    """Fit on the checked training labels of documents the rules keep, and fix the threshold."""
    entries = checked(load_labels(LABELS), "train")
    ids = [entry["id"] for entry in entries]
    connection = await connect(url)
    try:
        dropped = await rule_dropped(connection, ids)
        vectors = await embeddings(connection, ids, table)
    finally:
        await connection.close()
    used = [e for e in entries if e["id"] not in dropped and e["id"] in vectors]
    weights, bias, out_of_fold = fit([vectors[e["id"]] for e in used], [e["label"] for e in used])
    threshold = choose_threshold(list(zip(out_of_fold, [e["label"] for e in used], strict=True)))
    below = 0 if threshold is None else sum(score < threshold for score in out_of_fold)
    model = {
        "weights": weights,
        "bias": bias,
        "threshold": threshold,
        "trained_on": len(used),
        "below_threshold": below,
        "labels_hash": labels_hash(entries),
        "embeddings": table,
    }
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    MODEL.write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    print(f"trained on {len(used)}; threshold {threshold}, {below} training documents below it")
    if threshold is None:
        print("No safe threshold yet: label more candidates with low scores, then train again")


def drop_checks(entries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Checked drops, the wrong ones among them (labeled keep) and the safety bar."""
    labels = [entry["label"] for entry in entries if entry["label"] is not None]
    wrong = labels.count("keep")
    return {
        "checked": len(labels),
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
        "wrong": checks["wrong"],
        "upper_bound": checks["upper_bound"],
        "passes": {"safety": safe, "usefulness_2": share >= 0.02, "usefulness_3": share >= 0.03},
    }


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
        model_checks = drop_checks(in_set("drops-model"))
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

    labeled = [entry for entry in documents if entry["label"] is not None]
    proposed = [entry for entry in labeled if entry["proposal"] is not None]
    random_checked = [entry for entry in in_set("random") if entry["label"] is not None]
    unhelpful = [entry for entry in random_checked if entry["label"] == "unhelpful"]
    return {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "labels_hash": labels_hash(labeled),
        "total": total,
        "approaches": {"rules": rules, "rules+model": combined},
        "rules": per_rule,
        "model": None
        if model is None
        else {
            "threshold": model.get("threshold"),
            "trained_on": model.get("trained_on"),
            "below_threshold": model.get("below_threshold"),
            "stale": labels_hash(checked(labels, "train")) != model.get("labels_hash"),
        },
        "llm_agreement": {
            "checked": len(proposed),
            "agreed": sum(entry["proposal"]["label"] == entry["label"] for entry in proposed),
        },
        "random": {
            "checked": len(random_checked),
            "unhelpful": len(unhelpful),
            "by_group": {g: sum(str(e["group"]) == g for e in unhelpful) for g in ("1", "2")},
        },
        "timing": timing,
    }


PROPOSER = ("Qwen/Qwen3-4B", "1cfa9a7208912126459214e8b04321603b3df60c")


def qwen_generator() -> Callable[[str], str]:
    """The local proposer: non-thinking mode, greedy, at most 128 new tokens; mps if there."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    repository, revision = PROPOSER
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(repository, revision=revision)
    model = AutoModelForCausalLM.from_pretrained(
        repository, revision=revision, torch_dtype=torch.bfloat16
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
    done = 0
    for entry in todo:
        document = documents.get(entry["id"])
        if document is None:
            continue  # no longer stored here; a person can still label it
        answer = generate(build_prompt(document, data["guide"]))
        proposal = parse_answer(answer)
        if proposal is None:
            entry["proposal_raw"] = answer
        else:
            entry["proposal"] = proposal | {"model": model}
        done += 1
        if done % 10 == 0:
            save_labels(LABELS, data)
    save_labels(LABELS, data)
    print(f"proposed {done}, not stored here {len(todo) - len(documents)}")


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    if not args.database_url:
        raise SystemExit("Set DATABASE_URL or pass --database-url")
    if args.command == "sample":
        asyncio.run(sample(args.database_url, args.set, args.n))
    elif args.command == "propose":
        asyncio.run(propose(args.database_url, args.set, args.limit, qwen_generator()))
    elif args.command == "train":
        asyncio.run(train(args.database_url, args.embeddings))
    else:
        raise SystemExit(f"{args.command}: not implemented")


if __name__ == "__main__":
    main()
