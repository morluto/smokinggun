# Footgun

Footgun is a local CLI for software-engineering agents: it finds code-complexity hotspots and helps test optimization ideas with evidence. It scans source and repository context, imports external findings, and can compare explicitly authorized baseline/candidate measurements. It reports coverage, assumptions, and unknowns; it does not rewrite source.

## Rules for agents

- Keep static scans read-only, offline, and non-executing.
- Never turn missing or failed coverage into a clean result.
- Measurements require a declared workload and `--execute`; `--yes` is not execution consent.
- Preserve stable protocol schemas, finding IDs, paths, output formats, exit codes, and artifact layout.
- Machine output is one document on stdout; diagnostics belong on stderr.
- No telemetry, MCP, Python runtime, implicit plugins, or automatic edits in 1.0.

## Code map

`src/protocol` owns contracts; `src/scan`, `src/scanners`, `src/context`, and `src/adapters` own analysis and evidence; `src/execution`, `src/investigations`, and `src/reports` own measurement and reporting; `src/commands` only wires the CLI. `fixtures/corpus` contains labeled examples, `schemas` and `grammars` are release assets, and `dist` is generated.

Use Node 22+ and pnpm 11.20.0. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`; also run `pnpm evaluate:corpus` for scanner changes, `pnpm test:cli` for CLI changes, and package/release checks when changing distribution.
