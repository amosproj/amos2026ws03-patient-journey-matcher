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
import unicodedata
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


# Procedures: diagnostic techniques, therapies and operations. The first kind that
# matches a tree number wins; it gives the role and the MeSH qualifier of the
# procedure's papers. Radiosurgery is a radiotherapy; an operation that MeSH also lists
# among endoscopies (video-assisted thoracic surgery) is an operation by its name.
PROCEDURE_KINDS = (
    ("E02.815", "radiotherapy"),
    ("E01.370.350", "imaging"),
    ("E01.370", "diagnostic"),
    ("E04", "surgery"),
    ("E02.319", "drug"),
    ("E02", "therapy"),
)
OPERATION = re.compile(r"surg|ectom|otom(?:y|ies)\b|resection|plasty|anastomos", re.I)
# No procedure a patient receives: whole fields, laboratory methods, examinations,
# care settings and treatment strategies. Their names are common words in clinical
# texts and titles ("Behandlung", "Nachsorge", "follow-up care"), as the synthetic
# journeys and the titles of the local index showed.
EXCLUDED_TREES = tuple(
    """
    E01.370.049 E01.370.060 E01.370.225 E01.370.350.515 E01.370.360 E01.370.395
    E01.370.398 E01.370.400 E01.370.500 E01.370.503 E01.370.505 E01.370.510 E01.370.520
    E01.370.600 E01.370.620 E01.370.685 E01.370.760 E01.370.872 E01.370.928 E01.370.985
    E02.075 E02.085 E02.134 E02.168 E02.175 E02.183 E02.185 E02.197 E02.208 E02.365
    E02.479 E02.534 E02.547 E02.637 E02.674 E02.760 E02.765 E02.770 E02.782 E02.785
    E02.860 E02.887 E02.897 E02.900 E02.919 E02.921 E02.931 E02.950 E02.990 E04.030
    E04.079 E04.085 E04.249 E04.506 E04.510 E04.582 E04.604 E04.614
    """.split()
)
EXCLUDED = {
    "D003933",  # Diagnosis: the whole field
    "D019937",  # Diagnostic Techniques and Procedures: the whole field
    "D003952",  # Diagnostic Imaging: the whole field
    "D013812",  # Therapeutics: "Behandlung", "Therapie", "treatment"
    "D013514",  # Surgical Procedures, Operative: the whole field
    "D003131",  # Combined Modality Therapy: a strategy
    "D004358",  # Drug Therapy: "Chemotherapie"; MeSH uses the qualifier instead
    "D002369",  # Castration: in "castration-resistant"
    "D014143",  # Traction: its German name is "Extension"
    "D007267",  # Injections: a route, not a treatment
    "D001794",  # Blood Pressure: a measurement
}


# German clinicians write "Rektumkarzinom" and "Rektumtumor"; German MeSH names a
# neoplasm by site "Rektumkrebs", "Rektumtumoren" and "Krebs des Rektums". These forms
# are added to the neoplasms by site (C04.588) when no other concept has the name.
NEOPLASM_VARIANTS = (
    (re.compile(r"^(\w+)krebs$"), ("{0}karzinom", "{0}tumor")),
    (re.compile(r"^(\w+)tumoren$"), ("{0}tumor", "{0}karzinom")),
    (re.compile(r"^Krebs (des|der) (.+)$"), ("Karzinom {0} {1}",)),
)


def normalize(text):
    """The name form of normalizeName in text.ts."""
    text = unicodedata.normalize("NFKD", text.replace("ß", "ss"))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return re.sub(r"[^\w]+|_", " ", text).strip()


def neoplasm_variants(diseases, sites, others):
    taken = defaultdict(set)
    for group in (diseases, *others):
        for descriptor, (name, aliases, *_) in group.items():
            for term in (name, *aliases):
                taken[normalize(term)].add(descriptor)
    proposed = defaultdict(set)
    for descriptor in sites:
        name, aliases, _ = diseases[descriptor]
        for term in (name, *aliases):
            for pattern, forms in NEOPLASM_VARIANTS:
                match = pattern.match(term)
                if match:
                    for form in forms:
                        proposed[form.format(*match.groups())].add(descriptor)
    for variant, descriptors in proposed.items():
        if len(descriptors) == 1 and normalize(variant) not in taken:
            diseases[next(iter(descriptors))][1].append(variant)


def procedure_kind(numbers, name):
    paths = [
        path
        for path in numbers
        if not any(
            path == tree or path.startswith(tree + ".") for tree in EXCLUDED_TREES
        )
    ]

    def under(prefix):
        return any(path == prefix or path.startswith(prefix + ".") for path in paths)

    kinds = [kind for prefix, kind in PROCEDURE_KINDS if under(prefix)]
    if kinds and kinds[0] != "radiotherapy" and under("E04") and OPERATION.search(name):
        return "surgery"
    return kinds[0] if kinds else None


def build(mesh_zip, mesh_map, icd_map, excluded=EXCLUDED):
    diseases = {}
    chemicals = {}
    procedures = {}
    sites = set()
    tree = {}
    with ZipFile(mesh_zip) as archive, archive.open("German_MeSH_2026.xml") as xml:
        for _, record in ET.iterparse(xml):
            if record.tag != "DescriptorRecord":
                continue
            numbers = [p.text for p in record.findall("TreeNumberList/TreeNumber")]
            paths = [p for p in numbers if p.startswith(("C", "F03"))]
            medication = (
                record.find("PharmacologicalActionList/PharmacologicalAction")
                is not None
            )
            descriptor = record.findtext("DescriptorUI")
            # The bilingual descriptor name is German[English].
            name = (
                record.findtext("DescriptorName/String")
                .rsplit("[", 1)[-1]
                .removesuffix("]")
            )
            kind = None if descriptor in excluded else procedure_kind(numbers, name)
            if paths or medication or kind:
                aliases = {
                    t.text
                    for t in record.findall("ConceptList/Concept/TermList/Term/String")
                    if t.text
                }
                if paths:
                    diseases[descriptor] = [name, sorted(aliases - {name}), []]
                    if any(p.startswith("C04.588") for p in paths):
                        sites.add(descriptor)
                elif medication:
                    chemicals[descriptor] = [name, sorted(aliases - {name})]
                else:
                    procedures[descriptor] = [name, sorted(aliases - {name}), kind]
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
    neoplasm_variants(diseases, sites, (chemicals, procedures))
    for row in diseases.values():
        row[1] = sorted(set(row[1]))

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
    return {
        "diseases": diseases,
        "chemicals": chemicals,
        "procedures": procedures,
        "icd": icd,
    }


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
    compressed = bytearray(gzip.compress(encoded, mtime=0))
    compressed[9] = 255  # OS "unknown": zlib on macOS writes its own code
    DEST.write_bytes(compressed)
    print(
        f"{len(data['diseases'])} diseases, {len(data['procedures'])} procedures, "
        f"{len(data['icd'])} exact WHO codes"
    )


if __name__ == "__main__":
    main()
