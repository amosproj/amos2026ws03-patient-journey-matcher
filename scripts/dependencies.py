"""Write the direct dependencies of crawler/ and matcher/ to out/dependencies.tsv.

out/ is gitignored. Versions and licences come from the installed packages, so
run `uv sync --locked` in crawler/ and `pnpm install --frozen-lockfile` in
matcher/ first. From the repository root:

    uv run --project crawler python scripts/dependencies.py
"""

import json
import re
import tomllib
from importlib.metadata import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def python_dependencies():
    pyproject = tomllib.loads((ROOT / "crawler/pyproject.toml").read_text())
    groups = {
        "runtime": pyproject["project"]["dependencies"],
        "dev": pyproject["dependency-groups"]["dev"],
    }
    for scope, requirements in groups.items():
        for requirement in requirements:
            name = re.match(r"[A-Za-z0-9._-]+", requirement)[0]
            meta = metadata(name)
            licence = meta.get("License-Expression") or meta.get("License") or ""
            yield name, meta["Version"], licence, scope


def npm_dependencies():
    matcher = ROOT / "matcher"
    for package_dir in [
        matcher,
        *sorted(p.parent for p in matcher.glob("*/package.json")),
    ]:
        manifest = json.loads((package_dir / "package.json").read_text())
        for field, scope in [("dependencies", "runtime"), ("devDependencies", "dev")]:
            for name in manifest.get(field, {}):
                installed = package_dir / "node_modules" / name / "package.json"
                package = json.loads(installed.read_text())
                yield name, package["version"], package.get("license", ""), scope


rows = sorted(
    [*python_dependencies(), *npm_dependencies()], key=lambda row: row[3] != "runtime"
)
lines = ["#\tContext\tName\tVersion\tLicense\tScope\tComment"]
seen = set()
for name, version, licence, scope in rows:
    if name not in seen:  # a package used by several workspace packages gets one row
        seen.add(name)
        lines.append(f"{len(seen)}\t\t{name}\t{version}\t{licence}\t{scope}\t")

output = ROOT / "out/dependencies.tsv"
output.parent.mkdir(exist_ok=True)
output.write_text("\n".join(lines) + "\n")
print(f"Wrote {len(seen)} dependencies to {output.relative_to(ROOT)}")
