# SmokingGun

Local complexity scanner and optimization evidence tool for software-engineering agents.

SmokingGun finds algorithmic complexity and performance hotspots, explains the evidence behind them, and helps agents test whether an optimization is worthwhile.

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

Or run a command without a global install:

```bash
npx smokinggun scan .
```

## Use the CLI

Scan a repository:

```bash
smokinggun scan .
smokinggun scan . --format markdown
smokinggun scan . --format sarif --output smokinggun.sarif
```

Reports include the hotspot, supporting evidence, estimated impact, coverage, assumptions, risks, and tests or measurements needed next.

Static scans are read-only, offline, and do not execute repository code or modify source files. Findings are candidates, not proof. Measurement requires a declared workload and explicit execution authorization; SmokingGun never rewrites code automatically.

## About

SmokingGun supports structural and semantic scanning, repository context, SARIF/SCIP and benchmark imports, and JSON, Markdown, SARIF, and terminal reports. Missing or failed coverage remains visible instead of being treated as a clean scan.

## Development

Requires Node 22+ and pnpm 11.20.0.

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

Quality gates: `pnpm lint` (oxlint), `pnpm format:check` (oxfmt), `pnpm knip`, `pnpm check:boundaries`, and `pnpm test:coverage`. Run `pnpm changeset` to record a release change intent. `pnpm test:cli` and `pnpm test:package` exercise the built package end-to-end.
