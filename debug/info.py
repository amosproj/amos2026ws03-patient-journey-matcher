"""Info screen: the machine, the timers, what runs, the topic files."""

import contextlib
import importlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import asyncpg
import common
from common import (
    ROOT,
    DbUnavailable,
    database_target,
    describe_error,
    mcp_port,
    mcp_running,
    run_db,
)

from crawler.seeds import TOPICS_DIR, TopicFileError, load_topic

INFO_TTL = 30.0  # seconds; systemd, Docker, processes, the database and git are probed this rarely
PROBE_TIMEOUT = 2.0
VM_SETUP = ROOT / "deploy" / "vm-setup.sh"
BACKUP_DIR = Path("/var/backups/matcher")
SOURCE_NAMES = {
    "pubmed": "PubMed",
    "arxiv": "arXiv",
    "zenodo": "Zenodo",
    "youtube": "YouTube",
    "podcast": "Podcast",
}
JOB_LABELS = {
    "matcher-index": "Index update",
    "matcher-backup": "Database backup",
    "matcher-prune": "Docker cleanup",
}
TRANSCRIBE_UNIT = "matcher-transcribe.service"
JOB_REPORTS = 10
"""Seconds after its last report that the job counts as running; it reports every 2 s."""
UNIT_STATE: dict[str, Any] = {"at": 0.0, "state": None}
UNIT_LOCK = threading.Lock()
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
CALENDAR = re.compile(
    r"(?:(?P<day>Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\*-\*-\* "
    r"(?P<hour>\d\d):(?P<minute>\d\d):(?P<second>\d\d) UTC"
)
SLOW: dict[str, Any] = {"at": 0.0, "data": None}
SLOW_LOCK = threading.Lock()
# The last CPU times, when they were read and the busy share since the reading before
CPU: dict[str, Any] = {"at": 0.0, "times": None, "value": None}
CPU_LOCK = threading.Lock()
# psutil.Process objects kept between probes: their CPU share is measured since the last probe
PROCESSES: dict[tuple[int, float], Any] = {}
try:
    psutil: Any = importlib.import_module("psutil")  # comes with the crawler's dependencies
except ImportError:  # pragma: no cover - the screen then shows less of the machine
    psutil = None


def probe(argv: list[str], **env: str) -> str | None:
    """The output of a read-only command; None if it is missing, fails or takes too long."""
    if shutil.which(argv[0]) is None:
        return None
    try:
        done = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
            check=False,
            env={**os.environ, **env} if env else None,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode == 0 else None


def guarded(section: Callable[[], Any]) -> Any:
    """One section of the info; its failure is shown there, not as an error of the screen."""
    try:
        return section()
    except Exception as error:
        return {"error": describe_error(error)}


def machine() -> dict[str, Any]:
    """Load, memory and disk now: cheap enough for every poll."""
    disk = shutil.disk_usage(ROOT)
    data: dict[str, Any] = {
        "host": socket.gethostname(),
        "os": platform.platform(terse=True),
        "cpus": os.cpu_count(),
        "load": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
        "disk": {"path": str(ROOT), "total": disk.total, "used": disk.used},
        "memory": None,
        "uptime": None,
        "cpu": None,
    }
    if psutil is not None:
        memory = psutil.virtual_memory()
        data["memory"] = {"total": memory.total, "used": memory.total - memory.available}
        data["uptime"] = round(time.time() - psutil.boot_time())
        data["cpu"] = cpu_share(psutil.cpu_times())
    return data


def cpu_share(times: Any) -> float | None:
    """How busy all cores were since the reading before, at most one reading a second.

    Not psutil.cpu_percent(): it keeps its last reading per thread, and every request has a
    thread of its own. The same sums as psutil's: guest time is part of user time on Linux.
    """
    total = sum(times) - getattr(times, "guest", 0.0) - getattr(times, "guest_nice", 0.0)
    idle = times.idle + getattr(times, "iowait", 0.0)
    with CPU_LOCK:
        now = time.monotonic()
        if now - CPU["at"] >= 1.0:
            last = CPU["times"]
            if last is not None and total > last[0]:
                CPU["value"] = round(100 * (1 - (idle - last[1]) / (total - last[0])), 1)
            CPU.update(at=now, times=(total, idle))
        return CPU["value"]  # type: ignore[no-any-return]


def own_runs() -> dict[str, Any]:
    """The crawler and indexer runs started from this page."""
    crawl, index = common.CURRENT, common.INDEXING
    return {
        "crawl": None
        if crawl is None
        else {
            "id": crawl.id,
            "command": crawl.command,
            "started_at": crawl.started_at,
            "store": crawl.store_url is not None,
        },
        "index": None
        if index is None or index.status != "running"
        else {"id": index.id, "command": index.command, "started_at": index.started_at},
    }


def planned_jobs() -> list[dict[str, Any]]:
    """The timers deploy/vm-setup.sh installs on the VM: every one of them, or an error."""
    text = VM_SETUP.read_text(encoding="utf-8")
    loop = re.search(r"^for entry in ([\w=: ]+); do$", text, re.MULTILINE)
    jobs: list[dict[str, Any]] = []
    for call in re.findall(r"^\s*timer\s+(.+)$", text, re.MULTILINE):
        if call.startswith('"crawler-$name" "*-*-* ${entry#*=}:00 UTC"') and loop:
            for entry in loop.group(1).split():
                name, _, at = entry.partition("=")
                jobs.append(
                    {
                        "id": f"crawler-{name}",
                        "label": f"{SOURCE_NAMES.get(name, name)} crawl",
                        "calendar": f"*-*-* {at}:00 UTC",
                        "unit": f"crawler@{name}.service",
                        "source": name,
                    }
                )
            continue
        match = re.fullmatch(r'([\w-]+) "([^"]+)" (\S+) "[^"]*"', call.strip())
        if match is None:
            raise ValueError(f"deploy/vm-setup.sh: cannot read the timer {call.strip()}")
        name, calendar, unit = match.groups()
        jobs.append(
            {
                "id": name,
                "label": JOB_LABELS.get(name, name),
                "calendar": calendar,
                "unit": unit,
                "source": None,
            }
        )
    if not jobs:
        raise ValueError("deploy/vm-setup.sh: no timers found")
    return jobs


def next_run(calendar: str, now: datetime) -> str | None:
    """The next time of a daily or weekly OnCalendar= value in UTC, as vm-setup.sh writes them."""
    match = CALENDAR.fullmatch(calendar)
    if match is None:
        return None
    start = now.replace(
        hour=int(match["hour"]),
        minute=int(match["minute"]),
        second=int(match["second"]),
        microsecond=0,
    )
    for days in range(8):
        at = start + timedelta(days=days)
        if at > now and match["day"] in (None, WEEKDAYS[at.weekday()]):
            return at.isoformat()
    return None


def systemd_time(value: str | None) -> str | None:
    """A timestamp of `systemctl show`: `@<seconds>`, or text in UTC; None for never."""
    if not value:
        return None
    if value.startswith("@"):
        return datetime.fromtimestamp(int(value[1:]), UTC).isoformat()
    try:
        moment = datetime.strptime(value, "%a %Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC).isoformat()


def systemd_units(names: list[str]) -> dict[str, dict[str, str]]:
    """The loaded units of `names` with their state; empty without systemd or these units."""
    output = probe(
        [
            "systemctl",
            "show",
            *names,
            "--timestamp=unix",
            "--property=Id,LoadState,ActiveState,SubState,Result,NextElapseUSecRealtime,"
            "LastTriggerUSec,ExecMainStartTimestamp,ExecMainExitTimestamp",
        ],
        TZ="UTC",
        LC_ALL="C",
    )
    units: dict[str, dict[str, str]] = {}
    for block in (output or "").strip().split("\n\n"):
        properties = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if properties.get("LoadState") == "loaded":
            units[properties["Id"]] = properties
    return units


def transcribe_unit() -> str | None:
    """The state of the job's systemd unit, as on the VM; None where there is none."""
    with UNIT_LOCK:
        if time.monotonic() - UNIT_STATE["at"] >= INFO_TTL or not UNIT_STATE["at"]:
            unit = systemd_units([TRANSCRIBE_UNIT]).get(TRANSCRIBE_UNIT)
            UNIT_STATE.update(at=time.monotonic(), state=unit and unit.get("ActiveState"))
        return UNIT_STATE["state"]  # type: ignore[no-any-return]


def schedule() -> dict[str, Any]:
    """The timers of the VM; live from systemd where this machine runs them."""
    jobs = planned_jobs()
    units = systemd_units(
        [f"{job['id']}.timer" for job in jobs]
        + [job["unit"] for job in jobs]
        + ["matcher-mcp.service", TRANSCRIBE_UNIT]
    )
    now = datetime.now(UTC)
    for job in jobs:
        timer, service = units.get(f"{job['id']}.timer"), units.get(job["unit"])
        job["live"] = timer is not None
        if timer is None:
            job["next"] = next_run(job["calendar"], now)
            continue
        job["next"] = systemd_time(timer.get("NextElapseUSecRealtime"))
        job["last"] = systemd_time(timer.get("LastTriggerUSec"))
        if service is not None:
            job["last_start"] = systemd_time(service.get("ExecMainStartTimestamp"))
            job["last_end"] = systemd_time(service.get("ExecMainExitTimestamp"))
            job["result"] = service.get("Result")
            # a oneshot service is "activating" while it runs
            job["running"] = service.get("ActiveState") in ("active", "activating", "reloading")
    mcp, transcribe = units.get("matcher-mcp.service"), units.get(TRANSCRIBE_UNIT)
    return {
        "live": any(job["live"] for job in jobs),
        "jobs": jobs,
        "mcp_service": None if mcp is None else mcp.get("ActiveState"),
        "transcribe_service": None if transcribe is None else transcribe.get("ActiveState"),
    }


async def database_facts(connection: Any) -> dict[str, Any]:
    """Size and sessions; the last stored run per source; the last indexed full text.

    A crawl stores one run per topic, so the last run of a source says little. With it come
    the topics of the source that have a run, and those whose newest run failed.
    """
    row = await connection.fetchrow(
        """SELECT pg_database_size(current_database()) AS size,
                  (SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database()) AS connections"""
    )
    facts: dict[str, Any] = {"target": database_target(), **dict(row)}
    facts["crawls"] = facts["indexed"] = None
    with contextlib.suppress(asyncpg.PostgresError):
        rows = await connection.fetch(
            "SELECT DISTINCT ON (source) source, finished_at, ok"
            " FROM crawl_runs ORDER BY source, id DESC"
        )
        topics = {
            row["source"]: row
            for row in await connection.fetch(
                """SELECT source, count(*) AS topics, count(*) FILTER (WHERE NOT ok) AS failed
                   FROM (SELECT DISTINCT ON (source, topic) source, ok
                         FROM crawl_runs, unnest(topics) AS topic
                         ORDER BY source, topic, id DESC) AS newest
                   GROUP BY source"""
            )
        }
        facts["crawls"] = [
            {
                "source": row["source"],
                "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
                "ok": row["ok"],
                "topics": topics[row["source"]]["topics"] if row["source"] in topics else 0,
                "failed_topics": topics[row["source"]]["failed"] if row["source"] in topics else 0,
            }
            for row in rows
        ]
    with contextlib.suppress(asyncpg.PostgresError):
        last = await connection.fetchval(
            "SELECT max(fetched_at) FROM keyword.full_texts WHERE status = 'indexed'"
        )
        facts["indexed"] = last.isoformat() if last else None
    facts["transcription"] = None
    with contextlib.suppress(asyncpg.PostgresError):
        job = await connection.fetchrow(
            f"""SELECT workers AS wanted, coalesce((state ->> 'workers')::int, 0) AS workers,
                       coalesce(reported_at > now() - interval '{JOB_REPORTS} seconds', false)
                           AS running
                FROM transcription"""
        )
        facts["transcription"] = dict(job) if job else None
    return facts


def database_probe() -> dict[str, Any]:
    try:
        return {"up": True, **run_db(database_facts, connect_timeout=PROBE_TIMEOUT)}
    except DbUnavailable as error:
        return {"up": False, "error": str(error)}


def containers() -> list[dict[str, str]] | None:
    """The running Docker containers by name; None without Docker or access to it."""
    output = probe(["docker", "ps", "--format", "{{json .}}"])
    if output is None:
        return None
    rows = []
    for line in output.splitlines():
        with contextlib.suppress(json.JSONDecodeError):
            item = json.loads(line)
            rows.append({"name": item.get("Names", ""), "status": item.get("Status", "")})
    return rows


def busiest_processes(limit: int = 8) -> list[dict[str, Any]] | None:
    """The processes with the most CPU since the last probe; names only, no arguments."""
    if psutil is None:
        return None
    rows, seen = [], set()
    for process in psutil.process_iter(["pid", "name", "create_time", "memory_info"]):
        key = (process.info["pid"], process.info["create_time"] or 0.0)
        seen.add(key)
        first = key not in PROCESSES  # the first reading has no base: no share yet
        known = PROCESSES.setdefault(key, process)
        try:
            cpu = known.cpu_percent(interval=None)
        except psutil.Error:
            continue
        memory = process.info["memory_info"]
        rows.append(
            {
                "name": process.info["name"] or "?",
                "pid": key[0],
                "cpu": None if first else cpu,
                "memory": memory.rss if memory else None,
            }
        )
    for gone in set(PROCESSES) - seen:
        del PROCESSES[gone]
    rows.sort(key=lambda row: (row["cpu"] or 0.0, row["memory"] or 0), reverse=True)
    return rows[:limit]


def code_version() -> dict[str, Any] | None:
    """The branch and commit of this checkout, and how many tracked files differ from it."""
    branch = probe(["git", "-C", str(ROOT), "rev-parse", "--abbrev-ref", "HEAD"])
    head = probe(["git", "-C", str(ROOT), "log", "-1", "--format=%h%x1f%s%x1f%cI"])
    if branch is None or head is None:
        return None
    commit, subject, date = (head.strip().split("\x1f") + ["", "", ""])[:3]
    changed = probe(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"])
    return {
        "branch": branch.strip(),
        "commit": commit,
        "subject": subject,
        "date": date,
        "changed": None if changed is None else len(changed.splitlines()),
    }


def backups() -> dict[str, Any] | None:
    """The newest database dump of the VM's nightly backup; None where there is none."""
    try:  # macOS keeps /var/backups for root: stat() fails instead of finding nothing
        if not BACKUP_DIR.is_dir():
            return None
        dumps = sorted(BACKUP_DIR.glob("*.dump"), key=lambda dump: dump.stat().st_mtime)[::-1]
    except PermissionError:
        return None
    newest = dumps[0].stat() if dumps else None
    return {
        "path": str(BACKUP_DIR),
        "count": len(dumps),
        "newest": None
        if newest is None
        else {
            "name": dumps[0].name,
            "size": newest.st_size,
            "at": datetime.fromtimestamp(newest.st_mtime, UTC).isoformat(),
        },
    }


def slow_info(fresh: bool) -> dict[str, Any]:
    """The probes that take a moment, at most once per INFO_TTL unless `fresh`."""
    with SLOW_LOCK:
        cached = SLOW["data"]
        if cached is not None and not fresh and time.monotonic() - SLOW["at"] < INFO_TTL:
            return cached  # type: ignore[no-any-return]
        data = {
            "schedule": guarded(schedule),
            "database": guarded(database_probe),
            "containers": guarded(containers),
            "processes": guarded(busiest_processes),
            "code": guarded(code_version),
            "backups": guarded(backups),
            "probed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        SLOW.update(at=time.monotonic(), data=data)
        return data


def info(fresh: bool = False) -> dict[str, Any]:
    return {
        "machine": guarded(machine),
        "runs": own_runs(),
        "mcp": {"url": f"http://127.0.0.1:{mcp_port()}/mcp", "running": mcp_running()},
        **slow_info(fresh),
    }


def query_groups(text: str, queries: list[str]) -> list[dict[str, Any]]:
    """The queries under the comment lines that head them in the file, or one plain group."""
    groups: list[dict[str, Any]] = []
    inside = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if not line.startswith((" ", "-", "#")):
            inside = line.startswith("queries:")
        elif inside and stripped.startswith("#") and line.startswith(" "):
            groups.append({"name": stripped.lstrip("#").strip(), "queries": []})
        elif inside and stripped.startswith("- "):
            if not groups:
                groups.append({"name": "", "queries": []})
            value = stripped[2:].strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            groups[-1]["queries"].append(value)
    groups = [group for group in groups if group["queries"]]
    if [query for group in groups for query in group["queries"]] != queries:
        return [{"name": "", "queries": queries}]
    return groups


def topic_detail(topic_id: str) -> dict[str, Any]:
    """One topic file, looked up among the files and never opened by a path from the URL."""
    path = next((path for path in TOPICS_DIR.glob("*.yaml") if path.stem == topic_id), None)
    if path is None:
        raise LookupError(f"No topic file {topic_id}.yaml")
    text = path.read_text(encoding="utf-8")
    base = {"id": path.stem, "file": f"crawler/topics/{path.name}", "yaml": text}
    try:
        topic = load_topic(path)
    except TopicFileError as error:
        return {**base, "label": path.stem, "error": str(error)}
    return {
        **base,
        "label": topic.label,
        "terms": topic.terms,
        "queries": query_groups(text, topic.queries),
        "channels": [{"name": channel.name, "url": channel.url} for channel in topic.channels],
        "podcasts": [
            {
                "key": feed.key,
                "name": feed.name,
                "url": feed.url,
                "publisher": feed.publisher,
                "audience": feed.audience,
            }
            for feed in topic.podcasts
        ],
    }
