# Footgun long-term specification

Status: design target; no implementation is implied by this document.

This project has two deliberately separate names and responsibilities:

| Surface | Name | Responsibility |
| --- | --- | --- |
| npm package | `footgun` | Distribute the CLI, scanner backends, adapters, and agent skill |
| CLI command | `footgun` | Run scans, combine scanner results, and produce reports |
| Agent skill | `$footgun` | Teach compatible agent hosts when and how to use `footgun` |
| repository/product | Footgun | Own the complete project and its research corpus |

The scanner is the primary product. The skill is a thin distribution and
orchestration layer around it. The project does not require an MCP server.

## Product boundary

Footgun is a local, evidence-oriented code-complexity scanner that combines
multiple static-analysis and, later, runtime-analysis backends. It generates
optimization candidates and explains the evidence behind them. It does not
claim to prove arbitrary program complexity or guarantee a universal speedup.

The core product must remain useful without an agent host:

```bash
npx footgun scan .
npx footgun scan . --scanner auto
npx footgun scanners list
```

The installed executable is named `footgun`:

```bash
footgun scan .
footgun scan . --scanner auto
footgun scanners list
footgun report
```

The skill adds agent guidance, not a second implementation. An agent session
should be able to invoke the CLI, inspect its structured output, read relevant
source context, and write a report without reimplementing scanner behavior in
prompt instructions.

## Design principles

1. Static findings are candidates, not proof.
2. Every finding carries its scanner provenance, assumptions, and confidence.
3. Unsupported language or unavailable tool means unknown coverage, not a clean scan.
4. CLI, skill, JSON output, and Markdown reports use one normalized finding model.
5. External scanners are optional adapters; the core package does not bundle every toolchain.
6. Raw third-party output remains available for inspection but does not become the public contract.
7. The default scan is read-only. Running workloads or changing files requires explicit user intent.
8. Reports distinguish theoretical complexity, empirical scaling, constant factors, and system bottlenecks.
9. A finding is not automatically an optimization. Behavior, workload, and measurement evidence must be evaluated before recommending a change.
10. Adding a language should not require editing the central ranking or report logic.

## CLI responsibilities

The `footgun` CLI owns the operational workflow:

- scanner discovery and selection;
- language and repository detection;
- invoking built-in and installed external scanners;
- scanner version and capability reporting;
- result normalization;
- finding deduplication and relationship tracking;
- ranking and filtering;
- JSON, Markdown, and bounded human-readable output;
- unavailable-tool, parse-error, partial-result, and unknown-coverage states;
- investigation manifests and artifact locations;
- optional workload, profiler, and benchmark execution in later phases.

The initial command groups are:

```text
footgun scan <path>       Static candidate discovery
footgun scanners list     Installed and available scanner backends
footgun explain <id>      Source context, assumptions, and related findings
footgun investigate       Build an evidence plan for selected candidates
footgun measure           Run an explicitly supplied workload or benchmark
footgun compare           Compare baseline and candidate evidence
footgun report            Render a saved investigation or scan report
footgun doctor            Check runtime, parser, and optional-tool availability
```

`scan` is the first-class path. `investigate`, `measure`, and `compare` extend
the scanner into an evidence workflow without moving that responsibility into
the agent skill.

Illustrative options:

```bash
footgun scan . --scanner auto --format json
footgun scan . --scanner python-semantic --max-findings 80
footgun scan . --only language:typescript --exclude test,dist
footgun investigate . --finding F-014 --plan-only
footgun measure . --workload ./benchmarks/import-users.json --execute
```

The exact flag names may change. The stable contract is that commands are
explicit, bounded, scriptable, and produce structured results.

## Scanner backend model

The CLI exposes one scanner interface over multiple backends.

Supported backend categories include:

- built-in AST scanners;
- Tree-sitter structural scanners;
- language-specific semantic analyzers;
- structural tools such as Lizard;
- optional external static analyzers installed by the user;
- runtime and profiling scanners in later phases;
- framework and database scanners for queries, rendering, I/O, and cache behavior.

External static-scanner results should use SARIF as the preferred interchange
format when available. Footgun should preserve SARIF tool identity, rule IDs,
locations, related locations, invocations, fingerprints, and fixes, then add
Footgun-owned complexity claims and measurement evidence in the normalized
finding or investigation sidecar.

Users may request one backend, several backends, or `auto`. In `auto` mode the
CLI selects compatible backends from the repository inventory and reports what
was selected, skipped, unavailable, or partially successful.

Each backend declares:

```text
id                  Stable backend identifier
version             Backend or adapter version
languages           Languages and language versions it understands
capabilities        Patterns, evidence types, and output fields it supports
detect              Repository/file detection rules
analyze             Analysis operation and normalized output
requirements        Runtime, executable, parser, or service requirements
sideEffects         Whether it reads, executes, writes, or contacts a service
```

The host should probe an adapter before invoking it. Adapter results must
distinguish `complete`, `partial`, `unavailable`, `blocked`, `failed`, and
`cancelled`, and must include coverage, diagnostics, request/configuration
digests, raw artifact references, and reproduction metadata. A missing or
failed optional adapter is unknown coverage, not an empty result. External
static analyzers should cross the boundary through SARIF where possible;
Footgun-specific complexity and measurement fields remain in an extension or
investigation sidecar.

The registry must support built-in backends and externally installed adapters
without changing the core report pipeline. Optional dependencies should not
make a read-only scan fail when they are absent.

## Normalized finding contract

Every backend emits a normalized finding. Raw backend output may be stored as
an artifact, but it is not required for downstream consumers.

```json
{
  "id": "F-014",
  "scanner": "python-semantic",
  "scanner_version": "1.0.0",
  "language": "python",
  "location": {
    "path": "src/foo.py",
    "line": 42,
    "column": 8,
    "end_line": 42,
    "end_column": 18
  },
  "symbol": "select_visible",
  "kind": "membership-in-loop",
  "claim": "May scale as O(n*m)",
  "confidence": "candidate",
  "assumptions": ["right-hand collection is list-like"],
  "evidence": {
    "source_span": "item.id in allowed_ids",
    "loop_context": "for item in items"
  },
  "related_findings": [],
  "status": "unvalidated"
}
```

Required semantics:

- `id` is stable within an investigation and reproducible from source location,
  pattern, and scanner provenance where possible;
- locations use normalized repository-relative paths and source spans;
- `claim` describes an estimate or observation, never an unsupported proof;
- `confidence` and `assumptions` are mandatory for candidate findings;
- `status` distinguishes unvalidated, supported, measured, rejected, blocked,
  and inconclusive findings;
- missing evidence is represented as unknown or unresolved, never as zero,
  false, or passing;
- findings from multiple scanners may be related, but duplicate evidence must
  not be counted as independent confirmation.

The Markdown renderer must preserve the confidence, assumptions, provenance,
and evidence state that appear in JSON.

## Evidence vocabulary

Reports use these claim classes:

| Claim | Meaning |
| --- | --- |
| `static-fact` | Directly observed source or repository fact |
| `theoretical-estimate` | Complexity derived under named assumptions |
| `empirical-scaling` | Observed behavior as declared inputs increase |
| `constant-factor` | Measured CPU, allocation, memory, I/O, or latency difference |
| `system-bottleneck` | Database, network, disk, rendering, scheduler, or infrastructure evidence |
| `behavioral` | Test or invariant result about observable behavior |
| `unknown` | Evidence unavailable, ambiguous, or inconclusive |

No report should collapse these classes into one score. A static `O(n*m)`
estimate and a measured 2x speedup answer different questions.

## Language-support architecture

“All languages” is an extensibility goal, not a claim that every language has
equal analysis quality. Footgun uses capability tiers so unsupported or weakly
supported languages remain honest and useful.

### Tier 0: repository inventory

Every repository receives language and toolchain inventory where detectable:

- file extensions and parser candidates;
- package managers and build manifests;
- compiler/interpreter versions;
- test and benchmark commands;
- generated, vendored, ignored, and binary paths;
- framework and database hints.

Tier 0 can report coverage and missing prerequisites without analyzing syntax.

### Tier 1: syntax-aware structural analysis

Use Tree-sitter or an equivalent parser family for broad language coverage.
Structural rules cover constructs with reasonably portable meaning:

- loop nesting;
- comprehensions and callbacks;
- recursion call sites;
- repeated sorting, searching, and collection operations;
- allocation and copying patterns where syntax exposes them;
- query, request, and rendering calls when framework rules identify them.

Syntax-aware findings include parse diagnostics and do not pretend to know
runtime types or library semantics.

### Tier 2: language-semantic adapters

Language adapters add stronger facts for specific ecosystems:

- inferred collection types and method complexity;
- control-flow and call-graph relationships;
- recursion measures and bounded loops;
- aliases, mutation, and data-flow constraints;
- compiler or language-runtime behavior;
- language-specific source and test conventions.

Python, JavaScript/TypeScript, Go, Java/Kotlin, Rust, C/C++, C#, Ruby, PHP,
Swift, and other languages can progress independently through this tier.

### Tier 3: framework and system adapters

Framework adapters identify behavior that syntax alone cannot establish:

- database query count, N+1 paths, query plans, and pagination;
- HTTP/API request batching, retries, and rate limits;
- UI render paths, derived work, virtualization, and event frequency;
- cache hits, misses, invalidation, and serialization;
- compiler, build, test, and generated-code behavior.

These adapters must keep framework-specific assumptions in the adapter rather
than leaking them into the language-neutral core.

### Tier 4: runtime and measurement adapters

Runtime adapters connect candidates to declared workloads and profilers:

- CPU and wall-clock profiles;
- allocations, heap, and memory pressure;
- system calls, I/O, network, and database activity;
- concurrency, blocking, contention, and scheduler behavior;
- browser or rendering measurements;
- scaling curves across controlled input sizes.

Runtime evidence validates a workload and environment. It does not become a
universal claim about every deployment.

## Language adapter contract

An adapter should be replaceable without changing the report writer or CLI
ranking policy. Its public contract is capability-oriented:

```text
identify(files, manifests) -> language inventory
parse(file) -> syntax tree or typed parse diagnostics
extract(tree) -> symbols, spans, calls, loops, collections, effects
analyze(facts, repository context) -> normalized findings
measurements() -> supported profiler and workload integrations
```

Adapters must:

- return structured parse failures instead of silently falling back;
- preserve source spans and repository-relative paths;
- declare assumptions and confidence;
- report grammar, compiler, runtime, and adapter versions;
- avoid executing code during static analysis;
- expose capability gaps explicitly;
- be testable against a language-specific labeled corpus.

The core must not depend on a language adapter’s internal AST classes. Adapters
translate into a small neutral intermediate representation containing source
spans, symbols, control-flow relationships, calls, collection facts, effects,
and diagnostics.

Repository context is a separate capability. A local syntax index is the
always-available fallback; SCIP is the first optional batch semantic-context
import; Kythe, LSIF, live LSP, and language-native indexes are optional
adapters. Context results record the indexer/schema version, repository
revision, artifact digest, build configuration, coverage, and stale/partial
state. “No callers found” is not a negative fact unless the context source
demonstrates complete coverage for that symbol and revision.

## Investigation lifecycle

The scanner-only path is read-only and completes after candidate generation.
The optional investigation path records progressively stronger evidence:

```text
created
  -> inventoried
  -> scanned
  -> context-resolved
  -> measurement-planned
  -> baseline-measured
  -> candidate-compared
  -> behavior-validated
  -> reported
```

Any stage may end as `blocked`, `inconclusive`, `unavailable`, `cancelled`, or
`failed`, with a typed reason and recovery action. A blocked measurement must
not be rendered as a passing or negative result.

An investigation records:

- repository revision and dirty-state policy;
- target finding IDs and source spans;
- callers, inputs, tests, and workload paths discovered;
- theoretical assumptions;
- baseline and candidate revisions or artifacts;
- benchmark commands and input parameters;
- repetitions, warmups, timeouts, resource limits, and environment;
- raw measurements and summarized statistics;
- behavior-test results and known semantic risks;
- scanner, adapter, parser, compiler, runtime, and tool versions;
- report provenance and artifact digests.

Benchmark records retain raw repeated values, warmups, loops, units, summary
statistics, outliers, input parameters, workload/dataset digests, subject
revision or artifact identity, environment, runner/timer metadata, behavior
results, and collection policy. Scaling series retain input sweep points,
candidate models, fit residuals, and the finite-range limitations of the fit.
Profiler records distinguish sampled profiles, counters, traces, and memory
snapshots and preserve sampling/timing metadata, overhead, dropped data,
symbolization status, and native artifact digests. A normalized summary never
replaces the raw benchmark or profiler artifact.

## Workload and execution safety

Static scan commands must not execute repository code. Measurement commands
must require an explicit execution mode and a declared workload.

Execution profiles should be separate and visible:

```text
read-only       source, metadata, and static analysis only
local-exec      declared local tests or benchmarks, bounded and cancellable
service-exec    declared local services or databases
candidate-write isolated candidate workspace only
```

Host adapters must state their actual controls. Linux namespace/seccomp tools,
Windows Job Objects, macOS authorization or container/VM execution, and OCI
containers do not provide identical security properties. A request for
constrained execution must not silently downgrade to unsandboxed local
execution; the report records the requested profile, actual backend, capability
probe, policy digest, and omission reasons.

The CLI must provide:

- command allowlists or explicit command confirmation;
- working-directory boundaries;
- cancellation and process-tree cleanup;
- time, memory, output, and artifact-size limits;
- controlled environment variables;
- network policy that is explicit rather than implicit;
- redaction of credentials and sensitive output;
- no writes to the user’s source tree by default;
- recovery after interrupted or partially completed runs.

The skill may recommend a measurement, but it must not turn an unbounded or
ambiguous command into an execution request without user authorization.

## Package and skill layout

The npm package should distribute the CLI and the skill together without
duplicating the scanner implementation:

```text
footgun/
  bin/footgun
  src/
    core/
    cli/
    scanners/
    adapters/
    reports/
  skills/
    footgun/
      SKILL.md
  package.json
```

The package’s public binary is `footgun`. Skill distribution is explicit:

```bash
npx skills add https://github.com/morluto/footgun --skill footgun
```

The package must not modify an agent directory during ordinary npm
installation. The shared Skills CLI owns placement, conflict handling, and
updates.

## Agent skill contract

`$footgun` should remain concise and procedural. It should tell an agent:

1. establish repository scope and available tools;
2. run `footgun scan` for a first pass;
3. inspect the source and repository context around selected findings;
4. choose additional scanner backends when they add distinct evidence;
5. keep static candidates separate from measured observations;
6. ask for or construct a workload only when appropriate;
7. verify behavior before recommending an optimization;
8. report unavailable tools, unknown coverage, and proof gaps;
9. avoid modifying files unless explicitly requested.

The skill may load the optimization playbook and report template as references,
but it must not contain a second copy of scanner rules. The CLI output and the
skill’s interpretation rules must use the same normalized finding vocabulary.

## Reporting and output

The CLI must support both machine and human consumers:

- stable JSON for scripts and compatible agents;
- Markdown for repository reports;
- concise terminal summaries for interactive use;
- raw artifacts for detailed scanner or profiler inspection.

The report should include:

- scope and inventory;
- scanner backends selected and skipped;
- coverage and parser diagnostics;
- ranked findings;
- provenance, confidence, assumptions, and unknowns;
- theoretical estimates;
- empirical measurements, if any;
- behavioral validation;
- recommended next action;
- files modified, if any;
- reproducibility metadata.

Scanner disagreement is valuable evidence. The report should show that two
backends disagree rather than silently choosing the more alarming result.

## Validation requirements

Each scanner backend needs a labeled corpus containing:

- true positives;
- realistic negatives;
- comments and strings that resemble code;
- nested syntax and callbacks;
- aliases, unknown types, and mutation;
- parse errors and generated files;
- language-version differences;
- framework-specific false-positive cases.

Corpus cases also label structural truth, semantic conditions, acceptable claim
class, expected confidence, context expectations, workload requirements, and
unsupported/unknown status. Evaluation reports precision, recall, F1, location
accuracy, parse coverage, unknown coverage, scan cost, and output stability by
language and finding kind. Synthetic fixtures, language/framework fixtures,
pinned repository tasks, and workload/equivalence cases remain separate so
synthetic rule recall is not mistaken for repository-level optimization
effectiveness.

The test suite should measure precision and recall by finding kind, not only
whether the process exits successfully. Tests must fail when expected outputs
change unexpectedly.

The complete product needs additional validation layers:

- CLI contract tests for arguments, formats, exit codes, and missing tools;
- adapter contract tests through the normalized interface;
- property tests for finding identity, deduplication, ordering, and serialization;
- repository fixtures covering multiple languages and build systems;
- synthetic workloads with known asymptotic behavior;
- repeated scaling measurements with warmups and noise reporting;
- cross-machine replay where performance claims matter;
- behavior tests covering empty inputs, duplicates, ordering, mutation, errors,
  permissions, pagination, caching, and cancellation;
- package tests from the packed npm artifact, not only the source checkout;
- skill discovery tests using a real Skills CLI in a temporary project.

No optimization recommendation is considered validated unless the applicable
behavior and measurement gates pass or the report explicitly states the gap.

## Roadmap gates

### Foundation

- Establish `footgun` package and `$footgun` skill names.
- Expose the `footgun` binary.
- Define the normalized finding schema and coverage states.
- Remove destructive or implicit package installation behavior.
- Add packed-artifact and isolated Skills CLI discovery tests.

### Scanner core

- Keep control-flow tracking syntax-aware and report parser coverage.
- Preserve source spans, symbols, assumptions, and scanner provenance.
- Add scanner registry and capability discovery.
- Keep Python semantic analysis interpreter-free and owned by the scanner.
- Add a Tree-sitter structural backend and labeled multi-language fixtures.

### Investigation evidence

- Add repository context and workload descriptors.
- Add baseline measurement and repeated-run summaries.
- Add profiler and benchmark adapters without making them mandatory.
- Persist reproducible investigation bundles.
- Add behavior and scaling gates before recommendations are promoted.

### Language expansion

- Add language adapters independently through the registry.
- Add semantic rules only when supported by labeled precision/recall evidence.
- Add framework/database adapters behind explicit capabilities.
- Maintain a language coverage matrix with parser, semantic, and runtime levels.

### Mature operation

- Support cross-machine replay and artifact verification.
- Track adapter compatibility and parser versions.
- Allow external scanner plugins with stable contracts and safe execution policies.
- Treat automatic code changes as a separate, opt-in product capability.

## Explicit non-goals

Footgun will not:

- claim universal Big-O proofs for arbitrary programs;
- treat a regex warning as a verified optimization;
- bundle every compiler, profiler, database, or language toolchain;
- mark unsupported code as clean;
- execute arbitrary repository commands silently;
- mutate the source tree during a default scan;
- make automatic edits before behavior and performance evidence exist;
- require MCP for the core workflow.

The long-term success condition is a scanner that can inspect many languages
through one CLI while remaining honest about which claims are syntax-derived,
which are language-aware, which are measured, and which remain unknown.
