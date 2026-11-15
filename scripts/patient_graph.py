"""Build the patient graph of one generated patient and write it to
patientdata/<patient>/graph.json, the input of the graph reader in
matcher/mcp-server/src/graph.ts. `make graph PATIENT=Patient-5` runs it.

It runs the two graph steps of the SS26 pipeline on the PDFs of the patient, in the
order of their event numbers (_e01, _e02, ...): Gemini reads a PDF
(workers/pipeline/llm/extractor.py) and Graphiti adds it to the graph
(workers/pipeline/graph/builder.py). Two things differ from SS26, so that it runs
without a Google Cloud project: an API key from Google AI Studio instead of Vertex AI,
and an embedded Kuzu database under out/patient-graph/ instead of Neo4j.

Needs GEMINI_API_KEY in the environment or in backend/.env. VERTEX_LLM_MODEL picks the
model and GEMINI_PACER_MIN_INTERVAL_S the pause between two calls of Graphiti's LLM,
like in the pipeline.

A free key allows only some documents per day. The run then stops, writes the graph of
the documents read so far and exits with an error; running it again goes on with the
next document. The database knows which documents it holds, so none is added twice.
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

# Before the SS26 imports: some of them read their settings while they are imported.
load_dotenv(ROOT / "backend/.env")

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
from graphiti_core.nodes import EntityNode, EpisodicNode  # noqa: E402
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

# The database and the running summary of each patient; out/ is not in git.
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
    if is_new:
        # Its Kuzu driver does not create the full-text indexes either. Right after the
        # database exists, so a new database never stays without them.
        for query in get_fulltext_indices(GraphProvider.KUZU):
            await driver.execute_query(query)
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


async def documents_in_graph(graphiti: Graphiti, patient: str) -> set[str]:
    """The file stems of the PDFs in the graph: the builder names the episode of a
    document <patient>__<file stem>__<date>."""
    episodes = await EpisodicNode.get_by_group_ids(graphiti.driver, [patient])
    return {episode.name.split("__")[1] for episode in episodes}


async def build(patient: str) -> None:
    pdfs = sorted((ROOT / "patientdata" / patient).glob("*.pdf"), key=event_number)
    if not pdfs:
        sys.exit(f"No PDFs in patientdata/{patient}.")
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit("Set GEMINI_API_KEY in the environment or in backend/.env.")
    # The extractor asks gemini_client for its client, which would log in to Vertex AI.
    # The API version v1 rejects the system instructions that the extractor sends.
    client = genai.Client(api_key=key, http_options={"api_version": "v1beta"})
    gemini_client._client = client

    STATE.mkdir(parents=True, exist_ok=True)
    graphiti = await open_graph(STATE / f"{patient}.kuzu", key, client)
    done = await documents_in_graph(graphiti, patient)
    # What the documents so far say about the patient; the extractor reads the next PDF with it.
    summary_file = STATE / f"{patient}.summary.txt"
    summary = summary_file.read_text() if summary_file.exists() else ""
    for pdf in pdfs:
        if pdf.stem in done:
            continue
        try:
            extraction = await analyze_document(
                pdf.read_bytes(), pdf.name, previous_summary=summary
            )
            # Before the graph step: if a call fails, the graph does not have the document
            # yet and the next run reads it again from the start.
            new_summary = await update_journey_summary(summary, extraction, pdf.name)
            await ingest(
                graphiti,
                uid=patient,
                doc_id=pdf.stem,
                doc_name=pdf.name,
                extraction=extraction,
            )
        except Exception as error:
            # Mostly the rate limit of the key.
            print(f"Stopped at {pdf.name}: {type(error).__name__}: {str(error)[:300]}")
            break
        done.add(pdf.stem)
        summary = new_summary
        summary_file.write_text(summary)
        print(f"[{len(done)}/{len(pdfs)}] {pdf.name}", flush=True)

    read = [pdf.name for pdf in pdfs if pdf.stem in done]
    if read:
        await write_graph(graphiti, patient, read)
    await graphiti.close()
    if len(read) < len(pdfs):
        sys.exit(f"{len(pdfs) - len(read)} documents are left. Run it again to go on.")
    print("The graph is complete.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: patient_graph.py <patient>, e.g. Patient-5")
    asyncio.run(build(sys.argv[1]))
