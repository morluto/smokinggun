# Footgun

Local complexity scanner and optimization evidence tool for software-engineering agents.

Footgun finds algorithmic complexity and performance hotspots, explains the evidence behind them, and helps agents test whether an optimization is worthwhile.

## Install

```bash
npm install -g footgun
footgun skill install
```

The skill is installed explicitly into:

```text
${CODEX_HOME:-~/.codex}/skills/complexity-optimizer
```

## Use

Scan a repository:

```bash
footgun scan .
footgun scan . --format markdown
footgun scan . --format sarif --output footgun.sarif
```

Ask an agent:

```text
Use $complexity-optimizer to inspect this repository and report the most valuable optimization opportunities.
```

Reports include the hotspot, supporting evidence, estimated impact, coverage, assumptions, risks, and tests or measurements needed next.

Static scans are read-only, offline, and do not execute repository code or modify source files. Findings are candidates, not proof. Measurement requires a declared workload and explicit execution authorization; Footgun never rewrites code automatically.

## About

Footgun supports structural and semantic scanning, repository context, SARIF/SCIP and benchmark imports, and JSON, Markdown, SARIF, and terminal reports. Missing or failed coverage remains visible instead of being treated as a clean scan.
