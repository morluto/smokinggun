# Codex Complexity Optimizer

Codex skill for analyzing a codebase, finding algorithmic complexity and performance hotspots, and producing safe optimization reports.

## Install

```bash
npm install -g codex-complexity-optimizer
```

The package installs the skill into:

```bash
${CODEX_HOME:-~/.codex}/skills/complexity-optimizer
```

You can also run the installer directly:

```bash
npx codex-complexity-optimizer
```

## Use

In Codex:

```text
Use $complexity-optimizer to analyze this codebase and give me a report.
```

By default, report-only prompts do not modify files. The skill reports file/line, current complexity, recommended change, expected complexity after the change, risk level, and tests or benchmarks needed.

To apply a change, ask explicitly:

```text
Use $complexity-optimizer to implement the lowest-risk optimization from the report and run the relevant tests.
```
