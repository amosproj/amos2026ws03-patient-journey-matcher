"""Regenerate data/mesh-terms.json.gz from checksummed ZB MED 2026 and Mondo mappings.

From the repository root run:
    python3 matcher/algorithms/graph/scripts/build-terminology.py

The offline alternative takes the three unmodified release files via --source-dir.
See NOTICE for sources and attribution.
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from urllib.request import urlopen
from zipfile import ZipFile

MESH = "https://repository.publisso.de/resource/frl:6529720/data"
MONDO = "https://raw.githubusercontent.com/monarch-initiative/mondo/v2026-11-03/src/ontology/mappings/"
DEST = Path(__file__).resolve().parents[1] / "data" / "mesh-terms.json.gz"


DIGESTS = {
    "German_MeSH_2026_XML.zip": "856e5df3cff734cbe74e76a06c4e72701e517c27ca69c3d3d695d28167e19bb6",
    "mondo_exactmatch_icd10who.sssom.tsv": "a3ed268b37e7d59ece8678081338581666223c441771176106cdc109da18fa1d",
    "mondo_exactmatch_mesh.sssom.tsv": "31a75eeb0ac99d09136be389449e8041010f74d4ecc5b5d3f0deb41a81414044",
}


def exact_matches(stream):
    rows = csv.DictReader(
        (line for line in stream if not line.startswith("#")), delimiter="\t"
    )
    result = defaultdict(set)
    for row in rows:
        if row["predicate_id"] == "skos:exactMatch":
            result[row["subject_id"]].add(row["object_id"])
    return result


def build(mesh_zip, mesh_map, icd_map):
    diseases = {}
    chemicals = {}
    tree = {}
    with ZipFile(mesh_zip) as archive, archive.open("German_MeSH_2026.xml") as xml:
        for _, record in ET.iterparse(xml):
            if record.tag != "DescriptorRecord":
                continue
            paths = [
                p.text
                for p in record.findall("TreeNumberList/TreeNumber")
                if p.text.startswith(("C", "F03"))
            ]
            medication = (
                record.find("PharmacologicalActionList/PharmacologicalAction")
                is not None
            )
            if paths or medication:
                descriptor = record.findtext("DescriptorUI")
                # The bilingual descriptor name is German[English].
                name = (
                    record.findtext("DescriptorName/String")
                    .rsplit("[", 1)[-1]
                    .removesuffix("]")
                )
                aliases = {
                    t.text
                    for t in record.findall("ConceptList/Concept/TermList/Term/String")
                    if t.text
                }
                if paths:
                    diseases[descriptor] = [name, sorted(aliases - {name}), []]
                else:
                    chemicals[descriptor] = [name, sorted(aliases - {name})]
                for path in paths:
                    tree[path] = descriptor
            record.clear()
    for path, descendant in tree.items():
        while "." in path:
            path = path.rsplit(".", 1)[0]
            if path in tree and tree[path] != descendant:
                diseases[tree[path]][2].append(descendant)
    for row in diseases.values():
        row[2] = sorted(set(row[2]))

    # Only compose two exact mappings through a unique Mondo identifier.
    mondo_mesh = exact_matches(mesh_map)
    by_code = defaultdict(set)
    for mondo, codes in exact_matches(icd_map).items():
        for code in codes:
            by_code[code.removeprefix("ICD10WHO:")].add(mondo)
    icd = {}
    for code, subjects in by_code.items():
        if len(subjects) != 1 or not re.fullmatch(
            r"[A-Z][0-9]{2}(?:\.[0-9]{1,2})?", code
        ):
            continue
        targets = mondo_mesh.get(next(iter(subjects)), set())
        if len(targets) == 1:
            target = next(iter(targets)).removeprefix("mesh:")
            if target in diseases:
                icd[code] = target
    return {"diseases": diseases, "chemicals": chemicals, "icd": icd}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        help="use local German_MeSH_2026_XML.zip and mondo_exactmatch_{mesh,icd10who}.sssom.tsv",
    )
    args = parser.parse_args()

    def read(filename, url):
        if args.source_dir:
            data = (args.source_dir / filename).read_bytes()
        else:
            with urlopen(url, timeout=120) as response:
                data = response.read()
        if hashlib.sha256(data).hexdigest() != DIGESTS[filename]:
            raise ValueError(f"Unexpected SHA256 for {filename}")
        return data

    def mapping(vocabulary):
        filename = f"mondo_exactmatch_{vocabulary}.sssom.tsv"
        return io.StringIO(read(filename, MONDO + filename).decode())

    data = build(
        io.BytesIO(read("German_MeSH_2026_XML.zip", MESH)),
        mapping("mesh"),
        mapping("icd10who"),
    )
    encoded = json.dumps(
        data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    DEST.write_bytes(gzip.compress(encoded, mtime=0))
    print(f"{len(data['diseases'])} descriptors, {len(data['icd'])} exact WHO codes")


if __name__ == "__main__":
    main()
