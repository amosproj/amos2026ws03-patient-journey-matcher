# Documentation

Build, user and technical documentation of the Patient Journey Matcher. New here: read the [software architecture](design/architecture.md) first, then explore the pipeline in the [debug UI](../debug/crawler/README.md) (`make debug`). Terms: [glossary](glossary.md). The team's investigations, with methods and measurements: [research](../research/README.md).

## User documentation

How to use the software.

- [MCP interface](user/mcp-interface.md): connect, try it, the tools `match_journey` and `get_source`, errors
- [Debug UI](../debug/crawler/README.md): the best way to explore the pipeline, one screen per step: crawler runs, stored documents, the index, the transcription job and each step of a match
- [Synthetic patients](../patientdata/patientdata.md): journeys and graphs to send for testing
- [Patient graph tool](../tools/patient-graph/README.md): build the patient graph of a synthetic patient, the second input form of `match_journey`

## Design documentation

The architecture and the code.

- [Software architecture](design/architecture.md): runtime and code components, technology stack, choices
- [Data sources](design/sources.md): what is crawled, keys, request budgets, licences
- [Storage and retrieval](design/storage.md): tables, columns, who writes and who reads them
- [Keyword matching](design/keyword-matching.md): how the keyword approach ranks sources, and its limits
- Next to the code: [crawler](../crawler/README.md), [matcher packages](../matcher/README.md), [adding an approach](../matcher/algorithms/README.md)

## Build and deploy documentation

- [Build, run and test](build-deploy/build.md): prerequisites, make targets, tests, CI
- [Local database](build-deploy/database.md)
- [Deployment](build-deploy/deployment.md): the VM, scheduled crawls, backups
