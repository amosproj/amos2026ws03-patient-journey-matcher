"""Regenerate data/mesh-terms.json.gz from checksummed ZB MED 2026 and Mondo mappings.

From the repository root run:
    python3 matcher/terminology/scripts/build-terminology.py

The offline alternative takes the four unmodified release files via --source-dir.
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
REVIEWED = DEST.with_name("icd10-mesh.json")


DIGESTS = {
    "German_MeSH_2026_XML.zip": "856e5df3cff734cbe74e76a06c4e72701e517c27ca69c3d3d695d28167e19bb6",
    "mondo_exactmatch_icd10cm.sssom.tsv": "8368d57d416b182b1394e99342abe2b0caafa1e5c87193ca31a2044c5969f890",
    "mondo_exactmatch_icd10who.sssom.tsv": "a3ed268b37e7d59ece8678081338581666223c441771176106cdc109da18fa1d",
    "mondo_exactmatch_mesh.sssom.tsv": "31a75eeb0ac99d09136be389449e8041010f74d4ecc5b5d3f0deb41a81414044",
}


def exact_matches(stream, titles=None):
    rows = csv.DictReader(
        (line for line in stream if not line.startswith("#")), delimiter="\t"
    )
    result = defaultdict(set)
    for row in rows:
        if row["predicate_id"] == "skos:exactMatch":
            result[row["subject_id"]].add(row["object_id"])
            if titles is not None:
                titles[row["object_id"]] = row["object_label"]
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

# The genitive of a one-word German name, as in "Rezidiv eines Magenkarzinoms" or "Folgen
# des Schlaganfalls": nouns ending in -om, -kt, -all or -ult take -s. The form is added
# to a disease when no other concept has the name.
GENITIVE = re.compile(r"[^\s,]{3,}(?:om|kt|all|ult)")


# Kinds of carcinoma that name no site: "Urothelkarzinom" or "Carcinoma in situ" beside
# an organ say what the tumour is, and alone they name no disease. The carcinomas whose
# only tree numbers lie under Carcinoma (C04.557.470.200), less those that name a site
# or a disease of their own.
HISTOLOGY_TREE = "C04.557.470.200"
NOT_HISTOLOGY = {
    "D002285",  # Carcinoma, Intraductal, Noninfiltrating: the target of D05.1
    "D018281",  # Cholangiocarcinoma: the target of C22.1
    "D018285",  # Klatskin Tumor: bile ducts
    "D007725",  # Krukenberg Tumor: ovary
    "D008039",  # Linitis Plastica: stomach
    "D008303",  # Malignant Carcinoid Syndrome: a syndrome
    "D000069295",  # Mammary Analogue Secretory Carcinoma: salivary glands
    "D010145",  # Paget Disease, Extramammary: skin
    "D010144",  # Paget's Disease, Mammary: breast
    "D011553",  # Pseudomyxoma Peritonei: peritoneum
    "D065646",  # Thyroid Carcinoma, Anaplastic: thyroid
    "D018263",  # Adenocarcinoma, Follicular: thyroid
    "D018265",  # Carcinoma, Papillary, Follicular: thyroid
    "D018280",  # Carcinoma, Skin Appendage: skin
    "D018266",  # Adenocarcinoma, Sebaceous: skin
    "D002281",  # Carcinoma, Basosquamous: skin
    "D057090",  # Eccrine Porocarcinoma: skin
}


# Neoplastic processes such as lymphatic metastasis or a residual tumour: descriptors
# whose neoplasm tree numbers all lie under C04.697. Beside a cancer they say how it
# behaves, and alone they name no disease. A cancer of unknown primary is a diagnosis
# of its own (C80).
PROCESS_TREE = "C04.697"
NOT_PROCESS = {"D009382"}  # Neoplasms, Unknown Primary

# ICD-10-CM categories that Mondo maps exactly while the WHO mapping and icd10-mesh.json
# lack them, for codes with a subcode: F32.1 is a depressive disorder. Left out are
# symptoms (R) and factors (Z), and categories that gather several diseases: a residual
# or combined title, a group of disorders, and those Mondo maps to a broader heading.
CM_GROUP = re.compile(
    r"\b(?:other|secondary|and|or|disorders|diseases)\b|elsewhere|unspecified|,",
    re.I,
)
CM_BROADER = {"B56", "N21", "N84"}  # Trypanosomiasis, Urolithiasis, Polyps


def normalize(text):
    """The name form of normalizeName in text.ts."""
    text = unicodedata.normalize("NFKD", text.replace("ß", "ss"))
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return re.sub(r"[^\w]+|_", " ", text).strip()


def add_variants(diseases, others, propose, german):
    taken = defaultdict(set)
    for group in (diseases, *others):
        for descriptor, (name, aliases, *_) in group.items():
            for term in (name, *aliases):
                taken[normalize(term)].add(descriptor)
    proposed = defaultdict(set)
    from_german = set()
    for descriptor, (name, aliases, _) in diseases.items():
        for term in (name, *aliases):
            for form in propose(descriptor, term):
                proposed[form].add(descriptor)
                if term in german.get(descriptor, ()):
                    from_german.add(form)
    for variant, descriptors in proposed.items():
        if len(descriptors) == 1 and normalize(variant) not in taken:
            descriptor = next(iter(descriptors))
            diseases[descriptor][1].append(variant)
            if variant in from_german:
                german[descriptor].add(variant)


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


def build(mesh_zip, mesh_map, icd_map, cm_map, reviewed, excluded=EXCLUDED):
    diseases = {}
    chemicals = {}
    procedures = {}
    sites = set()
    histology = set()
    processes = set()
    german = defaultdict(set)
    tree = {}
    with ZipFile(mesh_zip) as archive, archive.open("German_MeSH_2026.xml") as xml:
        for _, record in ET.iterparse(xml):
            if record.tag != "DescriptorRecord":
                continue
            numbers = [p.text for p in record.findall("TreeNumberList/TreeNumber")]
            paths = [p for p in numbers if p.startswith(("C", "F03"))]
            if (
                numbers
                and all(p.startswith("C04.557") for p in numbers)
                and any(
                    p == HISTOLOGY_TREE or p.startswith(HISTOLOGY_TREE + ".")
                    for p in numbers
                )
                and record.findtext("DescriptorUI") not in NOT_HISTOLOGY
            ):
                histology.add(record.findtext("DescriptorUI"))
            neoplasm = [p for p in numbers if p.startswith("C04")]
            if (
                neoplasm
                and all(p.startswith(PROCESS_TREE) for p in neoplasm)
                and record.findtext("DescriptorUI") not in NOT_PROCESS
            ):
                processes.add(record.findtext("DescriptorUI"))
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
                # ZB MED's own terms: TermUI ger…; NLM's English ones: T…
                german[descriptor] = {
                    t.findtext("String")
                    for t in record.findall("ConceptList/Concept/TermList/Term")
                    if t.findtext("TermUI", "").startswith("ger") and t.findtext("String")
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
    def clinical_forms(descriptor, term):
        for pattern, forms in NEOPLASM_VARIANTS if descriptor in sites else ():
            match = pattern.match(term)
            if match:
                yield from (form.format(*match.groups()) for form in forms)

    add_variants(diseases, (chemicals, procedures), clinical_forms, german)
    add_variants(
        diseases,
        (chemicals, procedures),
        lambda _, term: [term + "s"] if GENITIVE.fullmatch(term) else [],
        german,
    )
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
    titles = {}
    by_category = defaultdict(set)
    for mondo, codes in exact_matches(cm_map, titles).items():
        for code in codes:
            by_category[code].add(mondo)
    icd_cm = {}
    for code, subjects in by_category.items():
        category = code.removeprefix("ICD10CM:")
        if (
            len(subjects) != 1
            or not re.fullmatch(r"[A-Z][0-9]{2}", category)
            or category[0] in "RZ"
            or category in icd
            or category in reviewed
            or category in CM_BROADER
            or CM_GROUP.search(titles[code])
        ):
            continue
        targets = mondo_mesh.get(next(iter(subjects)), set())
        if len(targets) == 1:
            target = next(iter(targets)).removeprefix("mesh:")
            if target in diseases:
                icd_cm[category] = target
    return {
        "diseases": diseases,
        "chemicals": chemicals,
        "procedures": procedures,
        "histology": sorted(histology),
        "processes": sorted(processes),
        "icd": icd,
        "icd_cm": icd_cm,
        "german": {d: sorted(names) for d, names in german.items() if names},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        help="use local German_MeSH_2026_XML.zip and mondo_exactmatch_{mesh,icd10who,icd10cm}.sssom.tsv",
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

    reviewed = json.loads(REVIEWED.read_text())
    data = build(
        io.BytesIO(read("German_MeSH_2026_XML.zip", MESH)),
        mapping("mesh"),
        mapping("icd10who"),
        mapping("icd10cm"),
        {code for group in ("codes", "categories") for code in reviewed[group]},
    )
    encoded = json.dumps(
        data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    compressed = bytearray(gzip.compress(encoded, mtime=0))
    compressed[9] = 255  # OS "unknown": zlib on macOS writes its own code
    DEST.write_bytes(compressed)
    print(
        f"{len(data['diseases'])} diseases, {len(data['procedures'])} procedures, "
        f"{len(data['icd'])} exact WHO codes, "
        f"{len(data['icd_cm'])} ICD-10-CM categories"
    )


if __name__ == "__main__":
    main()
