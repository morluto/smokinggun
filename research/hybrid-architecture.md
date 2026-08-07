# SmokingGun evidence architecture

This document describes the implementation boundary, not a historical
prototype.

## Pipeline

    CLI/config boundary
        -> normalized RuntimeConfig and RuntimeContext
        -> repository inventory and path-safe source reads
        -> structural scanners + Tree-sitter parse coverage
        -> TypeScript semantic index when applicable
        -> normalized findings, relations, coverage, diagnostics
        -> investigation bundle and explicit workload
        -> bounded execution and behavior checks
        -> measurement/comparison evidence
        -> JSON, Markdown, SARIF, or terminal projection

Each stage has a typed contract and can report complete, partial, unavailable,
blocked, failed, cancelled, or inconclusive work. A missing stage is not
converted into an empty successful result.

## Scanner boundary

Tree-sitter provides syntax and source spans. The structural scanner turns
those local observations into candidate findings with assumptions and
provenance. TypeScript compiler facts are added only by the semantic adapter.
Python analysis remains interpreter-free and is based on scanner-owned syntax
and data-flow facts. Framework, database, runtime, profiler, and benchmark
semantics remain explicit adapter responsibilities.

Cross-scanner findings are deterministically related by normalized location and
finding family. The relation records corroborating views without pretending
that wrappers over the same source evidence are independent confirmation.

## Investigation boundary

Investigation bundles begin with inventory or scan evidence and advance through
measurement planning, baseline measurement, candidate comparison, behavior
validation, and reporting. Each transition is stored as a content-addressed
snapshot. Workload commands use argument arrays without a shell, a bounded
environment allowlist, caller cancellation, timeout/output limits, and
repository-bound working directories.

The recommendation boundary is deliberately strict: behavior checks, repeated
measurements, immutable artifact identities, assumptions, and coverage must be
visible before a comparison is promoted.
