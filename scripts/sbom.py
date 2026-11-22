# /// script
# requires-python = ">=3.12"
# ///
"""Write the SBOM in SPDX 3.0 to sbom.spdx.json, which SCA Tool reads, and in CycloneDX 1.7 to
sbom.cdx.json: the third-party packages that the projects in this repository need to run, and
PostgreSQL with the extensions that db/Dockerfile puts into the database image, each with its
licence. From the repository root:

    uv run scripts/sbom.py          # make sbom
    uv run scripts/sbom.py --check  # fails if they no longer fit the lockfiles and db/Dockerfile

Syft, run in Docker, reads every lockfile in Git and looks up the licences on npm and PyPI. The
packages that only the development tools need are then left out: `uv export` and `pnpm sbom
--prod` name what a project needs to run, without the `dev` dependency group and the
devDependencies. Licences that the package metadata leaves unclear are set from ALIASES and
CHECKED. Syft converts the result to SPDX 3.0 and CycloneDX 1.7. Needs Docker, uv and pnpm.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPDX = ROOT / "sbom.spdx.json"
CYCLONEDX = ROOT / "sbom.cdx.json"
SYFT = "anchore/syft:v1.57.2"
SUPPLIER = "The AMOS Projects"  # the copyright holder in LICENSE; also the creator of the SBOM
REPOSITORY = "https://github.com/amosproj/amos2026ws03-patient-journey-matcher"

# Licence names in package metadata that are no SPDX ID, but mean one.
ALIASES = {
    "3-Clause BSD License": "BSD-3-Clause",
    "Apache 2": "Apache-2.0",
    "Apache 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "BSD 3-Clause OR Apache-2.0": "(BSD-3-Clause OR Apache-2.0)",
}
# Licences read in the licence file of a package whose metadata names none or an unclear one,
# such as "BSD". Per version, so that a new version is reported and checked again.
CHECKED = {
    "pkg:pypi/biopython@1.88": "LicenseRef-Biopython-License-Agreement",  # has no SPDX ID
    "pkg:pypi/colorama@0.4.6": "BSD-3-Clause",
    "pkg:pypi/impit@0.15.1": "Apache-2.0",
    "pkg:pypi/pyasn1-modules@0.4.2": "BSD-2-Clause",
}


def run(*command: str, cwd: Path = ROOT, stdin: str | None = None) -> str:
    """The output of a command; stops with its error message if it fails."""
    program = shutil.which(command[0])  # also finds pnpm.cmd on Windows
    if program is None:
        raise SystemExit(f"{command[0]} not found: scripts/sbom.py needs Docker, uv and pnpm")
    result = subprocess.run(
        [program, *command[1:]],
        cwd=cwd,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if result.returncode != 0:
        raise SystemExit(f"{' '.join(command)} failed:\n{result.stderr}")
    return result.stdout


def scan(licences: bool) -> dict:
    """Every package in the lockfiles, development tools included."""
    version = run("git", "describe", "--tags", "--always").strip()  # sprint-05-release-19-gd329c5a
    return json.loads(
        run(
            "docker", "run", "--rm", "--volume", f"{ROOT}:/src:ro", SYFT, "scan", "dir:/src",
            "--override-default-catalogers", "python-package-cataloger,javascript-lock-cataloger",
            "--exclude", "./.git/**",
            "--exclude", "./**/node_modules/**",
            "--exclude", "./**/.venv/**",
            "--source-name", "patient-journey-matcher",
            "--source-version", version,
            "--output", "spdx-json",
            "--quiet",
            *(["--enrich", "javascript", "--enrich", "python"] if licences else []),
        )
    )  # fmt: skip


def runtime(lockfile: Path) -> set[str]:
    """The purls of the third-party packages that the project of a lockfile needs to run."""
    if lockfile.name == "uv.lock":
        bom = run(
            "uv", "export", "--frozen", "--all-groups", "--no-group", "dev",
            "--no-emit-workspace", "--format", "cyclonedx1.5", "--quiet",
            cwd=lockfile.parent,
        )  # fmt: skip
    elif lockfile.name.endswith(".py.lock"):  # of a script, e.g. scripts/transcribe.py.lock
        bom = run(
            "uv", "export", "--frozen", "--script", str(lockfile.with_suffix("")),
            "--format", "cyclonedx1.5", "--quiet",
        )  # fmt: skip
    elif lockfile.name == "pnpm-lock.yaml":
        bom = run(
            "pnpm", "sbom", "--prod", "--lockfile-only", "--sbom-format", "cyclonedx",
            cwd=lockfile.parent,
        )  # fmt: skip
    else:
        raise SystemExit(f"{lockfile}: scripts/sbom.py does not know this kind of lockfile")
    components = json.loads(bom).get("components", [])
    if lockfile.name != "pnpm-lock.yaml":
        return {c["purl"] for c in components}
    # pnpm also lists the workspace packages that others depend on, without a download location
    return {c["purl"] for c in components if c.get("externalReferences")}


def purl(package: dict) -> str | None:
    refs = package.get("externalRefs", [])
    return next((r["referenceLocator"] for r in refs if r["referenceType"] == "purl"), None)


def found_in(package: dict) -> str | None:
    """The file a package was found in, a lockfile or db/Dockerfile; None for the root."""
    # "acquired package info from installed python package manifest file: /crawler/uv.lock"
    info = package.get("sourceInfo") or package.get("software_sourceInfo", "")
    _, found, path = info.rpartition(": /")
    return path if found else None


def database(root: str) -> tuple[list[dict], list[dict]]:
    """PostgreSQL and its extensions in the database image as SPDX 2.3 packages, which no lockfile
    names, and their relationships. The image tag names no minor version of PostgreSQL, so the
    SBOM names only its major version."""
    dockerfile = (ROOT / "db" / "Dockerfile").read_text(encoding="utf-8")
    image = re.search(r"^FROM pgvector/pgvector:([\d.]+)-pg(\d+)-(\w+)$", dockerfile, re.MULTILINE)
    textsearch = re.search(r"\b(postgresql-\d+-pg-textsearch)=(\S+)", dockerfile)
    if not image or not textsearch:
        raise SystemExit("db/Dockerfile names another image or package: update scripts/sbom.py")
    vector, major, debian = image.groups()
    deb, version = textsearch.groups()

    def package(name: str, version: str | None, purl: str) -> dict:
        return {
            "name": name,
            "SPDXID": f"SPDXRef-Package-db-{name}",
            **({"versionInfo": version} if version else {}),
            "supplier": "NOASSERTION",
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "sourceInfo": "named in the database image: /db/Dockerfile",
            "licenseConcluded": "NOASSERTION",
            "licenseDeclared": "PostgreSQL",  # all three, as their licence files say
            "copyrightText": "NOASSERTION",
            "externalRefs": [
                {"referenceCategory": "PACKAGE-MANAGER", "referenceType": "purl",
                 "referenceLocator": purl},
            ],
        }  # fmt: skip

    postgresql = package("postgresql", major, f"pkg:generic/postgresql@{major}")
    extensions = [
        package("pgvector", vector, f"pkg:github/pgvector/pgvector@v{vector}"),
        package(
            deb, version, f"pkg:deb/debian/{deb}@{version.replace('+', '%2B')}?distro={debian}"
        ),
    ]
    relationships = [
        {"spdxElementId": root, "relatedSpdxElement": p["SPDXID"], "relationshipType": "CONTAINS"}
        for p in (postgresql, *extensions)
    ] + [
        {"spdxElementId": postgresql["SPDXID"], "relatedSpdxElement": e["SPDXID"],
         "relationshipType": "DEPENDENCY_OF"}
        for e in extensions
    ]  # fmt: skip
    return [postgresql, *extensions], relationships


def build(licences: bool) -> dict:
    """The SBOM in SPDX 2.3, the format that Syft scans to, with the runtime packages only."""
    sbom = scan(licences)
    tracked = set(run("git", "ls-files").splitlines())
    keep = set()
    for path in sorted({found_in(p) for p in sbom["packages"]} - {None}):
        if path not in tracked:
            print(f"Left out {path}: not in Git", file=sys.stderr)
            continue
        needed = runtime(ROOT / path)
        found = {purl(p) for p in sbom["packages"] if found_in(p) == path}
        if missing := needed - found:
            raise SystemExit(f"{path}: Syft did not find {', '.join(sorted(missing))}")
        keep |= {(path, p) for p in needed}
    left_out = {
        p["SPDXID"]
        for p in sbom["packages"]
        if found_in(p) is not None and (found_in(p), purl(p)) not in keep
    }
    left_out |= {f["SPDXID"] for f in sbom.get("files", []) if f["fileName"] not in tracked}
    sbom["packages"] = [p for p in sbom["packages"] if p["SPDXID"] not in left_out]
    sbom["files"] = [f for f in sbom.get("files", []) if f["SPDXID"] not in left_out]
    for p in sbom["packages"]:
        if "externalRefs" in p:  # the purl, not the CPEs that Syft guesses from the name
            p["externalRefs"] = [r for r in p["externalRefs"] if r["referenceType"] == "purl"]
    sbom["relationships"] = [
        r
        for r in sbom["relationships"]
        if r["spdxElementId"] not in left_out and r["relatedSpdxElement"] not in left_out
    ]
    root = next(
        r["relatedSpdxElement"]
        for r in sbom["relationships"]
        if r["relationshipType"] == "DESCRIBES"
    )
    packages, relationships = database(root)
    sbom["packages"] += packages
    sbom["relationships"] += relationships
    # Syft turns each licence name into a LicenseRef by replacing what an ID may not contain.
    aliases = {f"LicenseRef-{re.sub(r'[^A-Za-z0-9.-]', '-', k)}": v for k, v in ALIASES.items()}
    for p in sbom["packages"]:
        p["licenseDeclared"] = CHECKED.get(purl(p) or "") or re.sub(
            r"LicenseRef-[A-Za-z0-9.-]+",
            lambda ref: aliases.get(ref.group(), ref.group()),
            p.get("licenseDeclared", "NOASSERTION"),
        )
    # The licence names that are no SPDX identifiers, e.g. "Biopython License Agreement", each
    # declared once: Syft declares some that only dropped packages use, and misses some.
    used = sorted(set(re.findall(r"LicenseRef-[A-Za-z0-9.-]+", json.dumps(sbom["packages"]))))
    declared = {i["licenseId"]: i for i in sbom.get("hasExtractedLicensingInfos", [])}
    sbom["hasExtractedLicensingInfos"] = [
        declared.get(ref)
        or {
            "licenseId": ref,
            "extractedText": "NOASSERTION",
            "name": ref.removeprefix("LicenseRef-").replace("-", " "),
        }
        for ref in used
    ]
    return sbom


def spdx3(spdx: dict) -> dict:
    """The SBOM in SPDX 3.0. What Syft's conversion gets wrong is corrected: it drops the file each
    package was found in, names no tool, and describes the repository as a file that Anchore, the
    maker of Syft, created in a namespace of its own."""
    sbom = json.loads(
        run(
            "docker", "run", "--rm", "--interactive", SYFT, "convert", "-",
            "--output", "spdx-json@3.0", "--quiet",
            stdin=json.dumps(spdx),
        )
    )  # fmt: skip
    info = {p["SPDXID"].removeprefix("SPDXRef-"): p.get("sourceInfo") for p in spdx["packages"]}
    for element in sbom["@graph"]:
        if found := info.get(element.get("spdxId", "").removeprefix("SPDXRef:")):
            element["software_sourceInfo"] = found
    # SPDX's own individuals (NoAssertionLicense): predefined in the model, a copy here breaks SHACL
    sbom["@graph"] = [
        e for e in sbom["@graph"] if not e.get("spdxId", "").startswith("https://spdx.org/rdf/")
    ]
    elements = {e.get("spdxId") or e.get("@id"): e for e in sbom["@graph"]}
    creation = next(e for e in sbom["@graph"] if e["type"] == "CreationInfo")
    creator = elements[creation["createdBy"][0]]
    creator["name"] = SUPPLIER
    elements[creation["createdUsing"][0]]["name"] = SYFT.rpartition("/")[2].replace(":v", "-")
    document = next(e for e in sbom["@graph"] if e["type"] == "SpdxDocument")
    root = elements[elements[document["rootElement"][0]]["rootElement"][0]]
    root["software_primaryPurpose"] = "application"
    root["suppliedBy"] = creator["spdxId"]
    namespace = f"{REPOSITORY}/sbom/{document['spdxId'].rpartition('/')[2]}"
    for entry in document.get("namespaceMap", []):
        if entry["namespace"] == document["spdxId"]:
            entry["namespace"] = namespace
    document["spdxId"] = namespace
    return sbom


def cyclonedx(spdx: dict) -> dict:
    """The SBOM in CycloneDX 1.7. What Syft's conversion gets wrong is corrected as in spdx3(). It
    also adds Debian, the system of the database image, as an operating system, and properties
    that it guesses from the purls, such as an installed size of 0 for pg_textsearch."""
    bom = json.loads(
        run(
            "docker", "run", "--rm", "--interactive", SYFT, "convert", "-",
            "--output", "cyclonedx-json@1.7", "--quiet",
            stdin=json.dumps(spdx),
        )
    )  # fmt: skip
    found = {p["SPDXID"].removeprefix("SPDXRef-"): found_in(p) for p in spdx["packages"]}
    names = {
        i["licenseId"].removeprefix("LicenseRef-"): i["name"]
        for i in spdx["hasExtractedLicensingInfos"]
    }
    bom["components"] = [c for c in bom["components"] if c["type"] != "operating-system"]
    for component in bom["components"]:
        component.pop("properties", None)
        if component["type"] == "file":
            continue
        # "pkg:pypi/colorama@0.4.6?package-id=Package-python-colorama-dbd476bddb1ce9ea"
        path = found.get(component["bom-ref"].rpartition("package-id=")[2])
        if path is None:
            raise SystemExit(f"Syft names {component['bom-ref']} otherwise: update scripts/sbom.py")
        component["evidence"] = {"occurrences": [{"location": path}]}
        for licence in component.get("licenses", []):  # Syft drops the LicenseRef- of a name
            if (name := licence.get("license", {}).get("name")) in names:
                licence["license"]["name"] = names[name]
    metadata = bom["metadata"]
    tool = metadata["tools"]["components"][0]
    tool["name"], _, tool["version"] = SYFT.rpartition("/")[2].partition(":v")
    metadata["manufacturer"] = {"name": SUPPLIER}  # of the SBOM
    metadata["component"].update(
        type="application",
        supplier={"name": SUPPLIER},
        externalReferences=[{"type": "vcs", "url": REPOSITORY}],
    )
    return bom


def unclear(sbom: dict) -> set[str]:
    """The packages whose declared licence has no SPDX licence ID and was not checked by hand."""
    elements = {e.get("spdxId"): e for e in sbom["@graph"]}

    def known(licence: str) -> bool:
        element = elements.get(licence, {})
        if element.get("type") == "expandedlicensing_ListedLicense":
            return True
        members = element.get("expandedlicensing_member", [])  # of an AND or OR
        return bool(members) and all(known(m) for m in members)

    return {
        f"{elements[r['from']]['name']} {elements[r['from']].get('software_packageVersion')}"
        for r in sbom["@graph"]
        if r["type"] == "Relationship"
        and r["relationshipType"] == "hasDeclaredLicense"
        and found_in(elements[r["from"]])
        and elements[r["from"]].get("software_packageUrl") not in CHECKED
        and not all(known(t) for t in r["to"])
    }


def write(path: Path, sbom: dict) -> None:
    text = json.dumps(sbom, indent=2, ensure_ascii=False) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


def contents(sbom: dict) -> list[tuple[str, ...]]:
    """What --check compares: the packages with the files they were found in and the checksums of
    the lockfiles, not the licences, which come from the network."""
    if "components" in sbom:  # CycloneDX
        components = sbom["components"]
        packages = [
            (c.get("purl") or c["name"], *(o["location"] for o in c["evidence"]["occurrences"]))
            for c in components
            if c["type"] != "file"
        ]
        files = [
            (c["name"], *sorted(h["content"] for h in c.get("hashes", [])))
            for c in components
            if c["type"] == "file"
        ]
        return sorted(packages + files)
    graph = sbom["@graph"]
    packages = [
        (e.get("software_packageUrl") or e["name"], found_in(e) or "")
        for e in graph
        if e["type"] == "software_Package"
    ]
    files = [
        (e["name"], *sorted(h["hashValue"] for h in e.get("verifiedUsing", [])))
        for e in graph
        if e["type"] == "software_File"
    ]
    return sorted(packages + files)


def check() -> None:
    for path in (SPDX, CYCLONEDX):
        if not path.exists():
            raise SystemExit(f"{path.name} is missing: run `make sbom`")
    spdx = build(licences=False)
    for path, convert in ((SPDX, spdx3), (CYCLONEDX, cyclonedx)):
        expected = contents(convert(spdx))
        actual = contents(json.loads(path.read_text(encoding="utf-8")))
        for entry in sorted(set(expected) - set(actual)):
            print("+", *entry)
        for entry in sorted(set(actual) - set(expected)):
            print("-", *entry)
        if expected != actual:
            raise SystemExit(f"{path.name} is out of date (+ new, - old): run `make sbom`")
        print(f"{path.name} fits the lockfiles and db/Dockerfile")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--check", action="store_true", help="compare, do not write")
    if parser.parse_args().check:
        check()
        return
    spdx = build(licences=True)
    sbom, bom = spdx3(spdx), cyclonedx(spdx)
    write(SPDX, sbom)
    write(CYCLONEDX, bom)
    packages = [e for e in sbom["@graph"] if e["type"] == "software_Package" and found_in(e)]
    print(f"Wrote {len(packages)} packages to sbom.spdx.json and sbom.cdx.json")
    if unknown := unclear(sbom):
        print(f"No SPDX licence ID for {len(unknown)}: {', '.join(sorted(unknown))}")


if __name__ == "__main__":
    main()
