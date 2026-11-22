# Agent instructions

## Project structure

What each folder holds: [repository](README.md#repository). Where new things go:

- `crawler/src/crawler/sources/`: a new data source; also add its name to `SourceName` (crawler and matcher) and to the `source` checks in `db/init/` (new numbered file)
- `crawler/topics/`: a new disease or field to crawl, one YAML file each ([topic files](crawler/README.md#topic-files))
- `matcher/algorithms/<name>/`: a new matching approach ([add an approach](matcher/algorithms/README.md#add-an-approach))
- `matcher/core/`, `matcher/db/`, `matcher/download/`: code that several matcher packages share (contracts, database access, full-text downloads)
- `matcher/mcp-server/src/`: the MCP tools
- `db/init/`: changes to the shared tables, in a new numbered file ([schema changes](Documentation/design/storage.md#schema-changes)); an approach keeps its own tables in its package
- `scripts/`: single-file scripts, such as the sample crawl; `deploy/`: scripts for the VM
- `tools/<name>/`: standalone helper programs, such as the [patient graph tool](tools/patient-graph/README.md)
- `patientdata/`: synthetic patients only, never real patient data
- `out/`: generated files, such as the SBOM; not committed

Tests go next to the code in `matcher/` (`x.test.ts`, [rules](matcher/README.md#rules)), [end-to-end tests](Documentation/build-deploy/build.md#end-to-end-tests) into `matcher/mcp-server/src/integration/` and crawler tests into `crawler/tests/`.

## Documentation

Most changes need no documentation. Don't document a change just because you made it. Update the docs only when:

- the change makes a doc wrong: correct the affected lines
- users or the team need to know it, for example a new command, setting, MCP tool, data source or architecture decision

Then write as little as possible:

- Add or change only the lines that are needed. No new sections, pages or READMEs unless asked.
- Each topic has one home. Elsewhere, link to it instead of repeating it.
- No implementation details that the code, `--help` or `.env.example` already explain, such as internal names, timings or a list of every option.
- No change summaries, changelogs or report files. What you changed goes into the commit message or PR.
- Plain, short English sentences, using the terms of the [glossary](Documentation/glossary.md). No emojis.

Where docs go:

- `Documentation/user/`: how to use the MCP server
- `Documentation/design/`: architecture and how the parts work
- `Documentation/build-deploy/`: build, run, test and deploy
- `research/`: studies and measurements
- `<component>/README.md`: that component, next to its code

List a new page in [Documentation/README.md](Documentation/README.md). `Deliverables/` and `research/snapshots/` are frozen.