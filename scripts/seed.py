"""Fill the database from `make db` with a sample crawl, to develop the indexer and the
MCP server against real documents. `make seed` runs it: about 1,500 documents in about
6 minutes.

Runs `crawler <source> --store` for all sources at the same time: each source has its
own rate limit, and store runs wait for each other. Each output line starts with its
source. Without YOUTUBE_API_KEY in crawler/.env, YouTube is skipped. Running it again
updates the stored documents and adds new ones.
"""

import asyncio
import os
import sys
import time
from pathlib import Path

from dotenv import dotenv_values

CRAWLER = Path(__file__).resolve().parent.parent / "crawler"
TOPICS = "--topic prostate_cancer --topic type2_diabetes --topic heart_failure"
# Channels and podcasts only, one field per topic above.
FIELDS = (
    "--topic general_cancer --topic general_endocrinology --topic general_cardiology"
)
# --max-depth 0: following references would take longer than the whole seed.
RUNS = {
    "pubmed": f"{TOPICS} --max-results 5 --max-depth 0",
    # One topic only: arXiv looks up the licence of every paper, 3 s apart.
    "arxiv": "--topic prostate_cancer --max-results 2 --max-depth 0",
    "zenodo": f"{TOPICS} --max-results 5",
    "youtube": f"{TOPICS} {FIELDS} --max-results 5",
    "podcast": f"{TOPICS} {FIELDS} --max-results 5",
}


async def crawl(source, arguments):
    """Run one crawler and print its output; True if it stored its run."""
    print(f"{source:<7} | crawler {source} {arguments} --store", flush=True)
    process = await asyncio.create_subprocess_exec(
        *[sys.executable, "-m", "crawler", source, *arguments.split(), "--store"],
        cwd=CRAWLER,
        env={**os.environ, "PYTHONUTF8": "1"},
        stdout=asyncio.subprocess.DEVNULL,  # the JSON Lines of the stored documents
        stderr=asyncio.subprocess.PIPE,
    )
    stored = False
    async for line in process.stderr:
        text = line.decode("utf-8", "replace").rstrip()
        stored = stored or text.startswith("stored (run ")
        print(f"{source:<7} | {text}", flush=True)
    await process.wait()
    return stored


async def main():
    runs = dict(RUNS)
    env_file = dotenv_values(CRAWLER / ".env")
    if not (os.environ.get("YOUTUBE_API_KEY") or env_file.get("YOUTUBE_API_KEY")):
        del runs["youtube"]
        print("youtube | skipped: no YOUTUBE_API_KEY in crawler/.env", flush=True)
    started = time.monotonic()
    stored = await asyncio.gather(*(crawl(name, args) for name, args in runs.items()))
    minutes, seconds = divmod(round(time.monotonic() - started), 60)
    failed = [source for source, ok in zip(runs, stored) if not ok]
    print(f"seed: finished in {minutes} min {seconds} s", end="")
    print(f"; nothing stored for {', '.join(failed)}" if failed else "")
    return 1 if failed else 0


try:
    raise SystemExit(asyncio.run(main()))
except KeyboardInterrupt:
    raise SystemExit(130) from None
