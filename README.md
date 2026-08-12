# SmokingGun

Optimization evidence for agents: find complexity hotspots and test whether a proposed change is worth making.

It keeps static findings, estimates, and measurements distinct so agents can decide what to investigate next.

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
```

Reports include the hotspot, supporting evidence, estimated impact, coverage, assumptions, risks, and tests or measurements needed next.

Static scans are read-only, offline, and do not execute repository code or modify source files. Findings are candidates, not proof. SmokingGun imports measurement evidence from existing benchmark tools; it does not launch workloads or rewrite code.

Semantic scanners consume the captured source snapshot directly. Explicitly authorized external adapters receive the same bytes through a private read-only view with no network namespace. Benchmark, profile, and measurement artifacts cross a strict import boundary and retain their declared provenance without granting execution authority. See [the authority architecture](docs/architecture.md) for the evidence invariants behind these choices.

## About

SmokingGun's authoritative path is immutable capture, snapshot-backed scanning, truthful coverage, content-addressed reporting, and explicit evidence imports. SARIF/SCIP, benchmarks, profiles, and measurements remain external inputs; missing or failed coverage stays visible instead of becoming a clean scan.

## Development

Requires Node 22+ and pnpm 11.20.0.

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Quality gates: `pnpm lint` (oxlint), `pnpm format:check` (oxfmt), `pnpm knip`, `pnpm check:boundaries`, and `pnpm test:coverage`. Run `pnpm changeset` to record a release change intent. `pnpm test:cli` and `pnpm test:package` exercise the built package end-to-end.
