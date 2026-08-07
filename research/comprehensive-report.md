# Footgun implementation report

Research status: 2026-08-05.

Footgun is a local, offline-by-default evidence broker for complexity
investigations. The package separates syntax-aware candidate generation,
repository context, controlled execution, behavior checks, measurement, and
reporting. A finding is never treated as proof of an asymptotic bound or a
speedup by itself.

## Current implementation

The shipped package provides:

- an ESM 'footgun' executable on Node 22.18 or newer;
- oclif commands for scanning, investigation, measurement, comparison,
  reporting, capability checks, explanations, SCIP context import, scanner
  discovery, and an optional shared Skills CLI skill;
- strict Zod contracts for findings, coverage, adapters, workloads, evidence,
  measurements, investigations, and typed problems;
- pinned Tree-sitter WASM grammars for Python, JavaScript, TypeScript, JSX,
  TSX, Go, Java, Kotlin, Rust, C, C++, C#, Ruby, PHP, and Swift;
- structural scanners, interpreter-free Python semantic facts, and TypeScript
  compiler-backed semantic facts;
- SARIF import, bounded one-shot subprocess adapters, and SCIP import;
- standard JSON benchmark importers for Hyperfine, pyperf, Google Benchmark,
  Criterion, and JMH, plus parameterized scaling measurements;
- pprof profile summaries through `pprof-format` and bounded Perfetto
  trace-processor JSON summaries, with raw source references;
- generated JSON Schemas for workload, measurement, scaling, adapter, benchmark,
  comparison, profile, and trace artifacts; and
- portable JSON, Markdown, SARIF, and terminal projections from one normalized
  report model; and
- repository inventory, content-addressed investigation snapshots, isolated
  candidate-write workspaces, and explicit behavior/cross-machine/control
  checks before comparison promotion.

Static scans read local files only. They do not execute repository source,
modify source files or contact the network
implicitly. Workload execution requires an explicit descriptor and --execute.

## Evidence and limits

The committed corpus contains labeled positive and negative cases across all 14
shipped grammar languages. Its precision/recall gate is run by the TypeScript
test suite and `footgun evaluate:corpus`, which reports a content digest plus
per-language and per-rule metrics; it is still a regression gate, not a claim
of language-wide accuracy. Parse coverage is reported separately from semantic
coverage, and unavailable or partial adapters remain visible in results.

The current local execution profile measures repeated subprocess timings and
validates explicit exit-code and output-digest checks. Unsupported isolation
and resource limits return typed unavailable results instead of silently
degrading. Parameterized workloads are measured point-by-point. Benchmark and
pprof artifacts enter through bounded, format-specific adapters and retain
their raw source reference and digest alongside normalized summaries. Raw
Perfetto traces can be queried through an explicitly installed trace processor;
the bounded CSV summary does not claim to contain unqueried trace data.

## Verification

The release checks currently cover TypeScript typechecking, direct Vitest,
Vite+ test execution, the content-digested labeled corpus, CLI stream and
exit-code behavior, grammar digests, packed file allowlists, executable mode,
Verdaccio install/upgrade/offline/global paths, and installation of the packed
tarball outside the source checkout. The package verifier also enforces
compressed and unpacked size budgets.

Remaining publication evidence is external to the source tree: trusted npm
publishing, registry freshness after publication, and the full hosted
multi-platform matrix must run in the release environment.
