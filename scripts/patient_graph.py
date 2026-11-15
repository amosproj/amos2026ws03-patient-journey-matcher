"""Build the patient graph of one generated patient and write it to
patientdata/<patient>/graph.json, the input of the graph reader in
matcher/mcp-server/src/graph.ts. `make graph PATIENT=Patient-5` runs it.

It runs the two graph steps of the SS26 pipeline on the PDFs of the patient, oldest
first: Gemini reads a PDF (workers/pipeline/llm/extractor.py) and Graphiti adds it to
the graph (workers/pipeline/graph/builder.py). Two things differ from SS26, so that it
runs without a Google Cloud project: an API key from Google AI Studio instead of
Vertex AI, and an embedded Kuzu database under out/patient-graph/ instead of Neo4j.

Needs GEMINI_API_KEY in the environment or in backend/.env. VERTEX_LLM_MODEL picks the
model and GEMINI_PACER_MIN_INTERVAL_S the pause between two calls, like in the pipeline.

A free key allows only some documents per day. The run then stops and writes the graph
of the documents read so far; running it again goes on with the next document.
"""

import asyncio
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The SS26 code imports itself as `workers...`, from backend/.
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv  # noqa: E402
from google import genai  # noqa: E402
from graphiti_core import Graphiti  # noqa: E402
from graphiti_core.driver.driver import GraphProvider  # noqa: E402
from graphiti_core.driver.kuzu_driver import KuzuDriver  # noqa: E402
from graphiti_core.edges import EntityEdge  # noqa: E402
from graphiti_core.embedder.gemini import (  # noqa: E402
    GeminiEmbedder,
    GeminiEmbedderConfig,
)
from graphiti_core.graph_queries import get_fulltext_indices  # noqa: E402
from graphiti_core.llm_client.config import LLMConfig  # noqa: E402
from graphiti_core.nodes import EntityNode  # noqa: E402
from workers.connections import gemini_client  # noqa: E402
from workers.connections.paced_gemini import (  # noqa: E402
    PacedGeminiClient,
    PacedGeminiRerankerClient,
)
from workers.pipeline.graph.builder import ingest  # noqa: E402
from workers.pipeline.llm.extractor import (  # noqa: E402
    analyze_document,
    update_journey_summary,
)

# The database and the progress of each patient; out/ is not in git.
STATE = ROOT / "out/patient-graph"
# SS26 embeds with text-embedding-005, which only Vertex AI has.
EMBEDDING_MODEL = "gemini-embedding-001"
# Only needed while the graph is built, and large.
EMBEDDINGS = {"name_embedding", "fact_embedding"}


def event_number(pdf: Path) -> tuple[int, str]:
    """The event of a name like laborbericht_e02.pdf, then the name: the reading order."""
    match = re.search(r"_e(\d+)", pdf.name)
    return (int(match.group(1)) if match else 0, pdf.name)


async def open_graph(database: Path, key: str, client: genai.Client) -> Graphiti:
    model = os.environ.get("VERTEX_LLM_MODEL", "gemini-2.5-flash")
    config = LLMConfig(api_key=key, model=model, small_model=model)
    is_new = not database.exists()
    driver = KuzuDriver(db=str(database))
    # graphiti-core 0.31.2 reads this attribute, but its Kuzu driver does not set it.
    driver._database = "kuzu"
    graphiti = Graphiti(
        graph_driver=driver,
        llm_client=PacedGeminiClient(config=config, client=client),
        embedder=GeminiEmbedder(
            config=GeminiEmbedderConfig(
                api_key=key, embedding_model=EMBEDDING_MODEL, embedding_dim=768
            ),
            client=client,
        ),
        cross_encoder=PacedGeminiRerankerClient(config=config, client=client),
    )
    await graphiti.build_indices_and_constraints()
    if is_new:
        # The Kuzu driver of graphiti-core 0.31.2 does not create the full-text indexes.
        for query in get_fulltext_indices(GraphProvider.KUZU):
            await driver.execute_query(query)
    return graphiti


async def write_graph(graphiti: Graphiti, patient: str, documents: list[str]) -> None:
    """Writes the nodes and edges as Graphiti holds them, in a fixed order."""
    nodes = [
        json.loads(node.model_dump_json(exclude=EMBEDDINGS))
        for node in await EntityNode.get_by_group_ids(graphiti.driver, [patient])
    ]
    edges = [
        json.loads(edge.model_dump_json(exclude=EMBEDDINGS))
        for edge in await EntityEdge.get_by_group_ids(graphiti.driver, [patient])
    ]
    graph = {
        "patient": patient,
        "documents": documents,
        "nodes": sorted(nodes, key=lambda node: (node["name"], node["uuid"])),
        "edges": sorted(edges, key=lambda edge: (edge["valid_at"] or "", edge["uuid"])),
    }
    out = ROOT / "patientdata" / patient / "graph.json"
    out.write_text(json.dumps(graph, indent=1, ensure_ascii=False) + "\n")
    print(f"{len(nodes)} nodes, {len(edges)} edges -> {out.relative_to(ROOT)}")


async def build(patient: str) -> None:
    pdfs = sorted((ROOT / "patientdata" / patient).glob("*.pdf"), key=event_number)
    if not pdfs:
        sys.exit(f"No PDFs in patientdata/{patient}.")
    load_dotenv(ROOT / "backend/.env")
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("Set GEMINI_API_KEY in the environment or in backend/.env.")
    # The extractor asks gemini_client for its client, which would log in to Vertex AI.
    # The API version v1 rejects the system instructions that the extractor sends.
    client = genai.Client(api_key=key, http_options={"api_version": "v1beta"})
    gemini_client._client = client

    STATE.mkdir(parents=True, exist_ok=True)
    progress = STATE / f"{patient}.json"
    state = {"documents": [], "summary": ""}
    if progress.exists():
        state = json.loads(progress.read_text())

    def save() -> None:
        progress.write_text(json.dumps(state, indent=1, ensure_ascii=False) + "\n")

    graphiti = await open_graph(STATE / f"{patient}.kuzu", key, client)
    for pdf in pdfs:
        if pdf.name in state["documents"]:
            continue
        try:
            extraction = await analyze_document(
                pdf.read_bytes(), pdf.name, previous_summary=state["summary"]
            )
            await ingest(
                graphiti,
                uid=patient,
                doc_id=pdf.stem,
                doc_name=pdf.name,
                extraction=extraction,
            )
            # Saved right after the graph has the document, so it is never added twice.
            state["documents"].append(pdf.name)
            save()
            state["summary"] = await update_journey_summary(state["summary"], extraction, pdf.name)
            save()
        except Exception as error:
            # Mostly the rate limit of the key. The next run goes on from here.
            print(f"Stopped at {pdf.name}: {type(error).__name__}: {str(error)[:300]}")
            break
        print(f"[{len(state['documents'])}/{len(pdfs)}] {pdf.name}", flush=True)

    await write_graph(graphiti, patient, state["documents"])
    await graphiti.close()
    left = len(pdfs) - len(state["documents"])
    print("The graph is complete." if left == 0 else f"{left} documents are left.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: patient_graph.py <patient>, e.g. Patient-5")
    asyncio.run(build(sys.argv[1]))
