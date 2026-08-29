# SmokingGun

Optimization evidence for agents: find complexity hotspots and test whether a proposed change is worth making.

It keeps static findings, estimates, imported measurements, and behavior evidence distinct so agents can decide what to investigate next.

## Install the agent skill

The optional `smokinggun` skill teaches compatible agent hosts how to use the CLI. Install it with the shared Skills CLI:

```bash
npx skills add https://github.com/morluto/smokinggun --skill smokinggun
```

The Skills CLI owns skill placement, conflict handling, and updates. SmokingGun does not modify agent configuration or install skills itself.

## Install the CLI

```bash
npm install -g smokinggun
```

Or bootstrap one scan without a global install:

```bash
npx --yes --package=smokinggun -- smokinggun scan .
```

This command may contact the npm registry. SmokingGun requires Node 22.18 or later.

## Use the CLI

Scan a repository:

```bash
smokinggun scan .
smokinggun scan . --format markdown
smokinggun scan . --format sarif --output smokinggun.sarif
smokinggun scan . --source-profile all
```

Reports include the hotspot, supporting evidence, coverage, assumptions, and the validation needed next.

The default `runtime` profile suppresses findings from tests, documentation, examples, and fixtures while retaining
those files in repository inventory. Use `--source-profile all` to scan every supported source file, or `--only <path>` to
focus explicitly on an auxiliary area.

Static scans are read-only, offline, and do not execute repository code or modify source files. Findings are candidates, not proof. SmokingGun imports measurement evidence from existing benchmark tools; it does not launch workloads or rewrite code.

Semantic scanners consume the captured source snapshot directly. Benchmark, profile, and measurement artifacts cross an import boundary without granting workload-execution authority. See [the authority architecture](docs/architecture.md) for the ownership rules behind these choices.

## Input requirements

Textual inputs—including configuration, reports, and JSON evidence artifacts—must be valid UTF-8. SmokingGun rejects malformed byte sequences instead of silently replacing them, because replacement text would no longer represent the captured evidence. Binary formats such as gzip-compressed pprof profiles remain binary until their format decoder handles them.

Numeric pprof fields must fit JavaScript's exact integer range (`Number.MIN_SAFE_INTEGER` through `Number.MAX_SAFE_INTEGER`). SmokingGun rejects values outside that range instead of rounding identifiers or measurements.

## About

SmokingGun's authoritative path is immutable capture, snapshot-backed scanning, truthful coverage, content-addressed reports, and explicit evidence imports. SARIF, SCIP, benchmarks, profiles, and measurements remain external inputs. Missing or failed coverage stays visible instead of becoming a clean scan.

## Development

Requires Node 22+ and pnpm 11.20.0.

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Quality gates: `pnpm lint` (oxlint), `pnpm format:check` (oxfmt), `pnpm knip`, `pnpm check:boundaries`, and `pnpm test:coverage`. Run `pnpm changeset` to record a release change intent. `pnpm test:cli` and `pnpm test:package` exercise the built package end-to-end.
