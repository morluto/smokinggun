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

## Quality gates

The CI `quality` job and the pre-commit hook enforce the same local gates:

- `pnpm lint` — oxlint (configuration in `.oxlintrc.json`).
- `pnpm format:check` — oxfmt (configuration in `.oxfmtrc.json`); `pnpm format` rewrites in place.
- `pnpm knip` — dead code, unused exports, and unused dependencies (configuration in `knip.json`).
- `pnpm check:boundaries` — enforces the code map: `src/protocol` imports no internal module, and nothing outside `src/commands`, `src/bin`, or `src/cli` imports `src/commands`.
- `pnpm test:coverage` — vitest coverage gate (`vitest.config.ts` thresholds; CLI wiring is excluded because `scripts/cli-smoke.mjs` exercises it end-to-end).

Releases go through changesets: run `pnpm changeset` to record a change intent, and the release workflow applies it via `pnpm version:packages` and publishes with `pnpm publish:packages`.

## Naming conventions

- Files and directories: kebab-case (`tree-sitter-runtime.ts`, `typescript-semantic.ts`).
- Functions and variables: camelCase; booleans read as questions (`isSupported`, `hasResult`).
- Types, classes, and interfaces: PascalCase; protocol document types end in `V1` (`ScanReportV1`, `ProblemV1`).
- Constants: camelCase; keep protocol constant names stable (they are part of the public contract).
- Tests: colocated `*.test.ts` beside the module under test.
