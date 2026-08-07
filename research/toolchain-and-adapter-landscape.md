# Toolchain and adapter landscape

Research pass: 2026-08-05.

This pass focused on the pieces that determine whether Footgun can support
many languages through one `footgun` CLI while keeping `$footgun`
as a thin, host-neutral agent skill. It used current Context7 documentation, DeepWiki
repository views, and the available GitContribute corpus.

## Findings at a glance

| Resource | What it contributes | What Footgun should take | Boundary to preserve |
| --- | --- | --- | --- |
| Tree-sitter | Incremental, error-tolerant syntax trees, queries, positions, language loading | Parser and query substrate; source spans; partial-parse diagnostics | Grammar and query definitions stay outside the core ranking/report policy |
| Semgrep | Staged rule/config resolution, target handling, parallel scan execution, structured errors and output | Explicit scan pipeline, per-target failure records, bounded parallelism, machine-readable output | Its rule engine is not a drop-in complexity proof or a plugin protocol |
| ast-grep | Tree-sitter rules, language inference/injection, rule tests, workers, native npm distribution | User-extensible structural rules, language registry, rule fixtures, cross-platform packaging lessons | Structural matching does not provide type, data-flow, or runtime evidence |
| SCIP | Language-neutral symbols, occurrences, definitions, references, and implementations | Optional repository-context index for callers and cross-file relationships | SCIP does not model asymptotic complexity, profiles, timings, or performance behavior |

## Tree-sitter

Context7 resolved `/tree-sitter/tree-sitter` as the high-reputation primary
library. The current documentation demonstrates parsing source into syntax
trees, source positions, multiple language bindings, included ranges for
embedded languages, and recoverable `ERROR` nodes.

DeepWiki exposes the project as separate components for the parser engine,
tree/node management, incremental parsing, query system, language bindings,
grammar generation, CLI testing, dynamic loading, and distribution.

### Implications for Footgun

Tree-sitter should be a parser substrate, not the whole analyzer. The first
useful abstraction is:

```text
repository file
  -> selected grammar
  -> syntax tree + diagnostics + source spans
  -> normalized structural facts
  -> scanner rules
  -> normalized finding
```

The scanner should retain byte offsets, rows, columns, and bounded source
spans. A syntax error should produce partial analysis plus a parse diagnostic
when possible; it should not silently fall back to a regex result with the
same confidence as a parsed result.

Tree-sitter queries are a strong candidate for declarative structural rules.
They allow language-specific matching to live in external query files and let
new rules be added without changing the core traversal code. Query execution
must still attach assumptions: a syntax match for `.find()` does not establish
that the operation is linear, repeated, or on a hot path.

Embedded-language handling matters for HTML, JSX, templates, SQL strings, and
similar files. Language adapters should be able to expose nested ranges and
related findings rather than treating an entire file as one language.

## Semgrep

Context7 resolved `/semgrep/semgrep-docs` as the primary documentation source.
The documentation covers JSON and SARIF output, local and registry rules, and
multiple configuration sources.

DeepWiki describes a staged architecture:

```text
rule/config resolution
  -> target discovery
  -> language parser selection
  -> scan execution
  -> match/result aggregation
  -> output formatting
```

It also describes per-target error conversion, parallel target execution,
intermediate types between stages, and a Python CLI wrapper over a separate
core engine.

### Implications for Footgun

Footgun should copy the separation of concerns, not Semgrep's implementation:

- parse CLI/configuration input into a scan configuration object;
- resolve scanner backends and rule sources before scanning;
- represent files/targets, parsed facts, findings, errors, and reports as
  distinct intermediate values;
- isolate a failed or timed-out file from the rest of a repository scan;
- report fatal startup errors separately from per-file partial results;
- use bounded parallelism only after measuring memory and parser contention;
- keep formatting out of scanning and normalization.

Semgrep also exposes a warning for Footgun: an extensive configuration object
can make a CLI difficult to discover. Footgun should group options by concern
and provide simple defaults, with advanced scanner-specific configuration in
separate files rather than an unbounded flag bag.

Semgrep's architecture is not evidence that every external scanner should be
run as a backend. Its engine modes are internally coordinated, and the
DeepWiki analysis explicitly notes that they are not equivalent to independent
plugin backends. Footgun needs a small adapter contract around external tools,
not a claim that all tools are interchangeable.

## ast-grep

Context7 resolved `/ast-grep/ast-grep.github.io` as the strongest documentation
match. Its documentation describes structural search, YAML rules, tests,
rewrites, language-specific patterns, and CLI workflows.

DeepWiki describes several especially relevant capabilities:

- language inference from extensions and explicit language selection;
- custom language registration and dynamic parser loading;
- language injection for embedded code;
- separate `run`, `scan`, `test`, `new`, `outline`, and editor-oriented commands;
- parallel workers that discover and process paths while the main thread
  collects ordered output;
- rule test directories and snapshots;
- precompiled native binaries distributed through npm and Python packages.

### Implications for Footgun

Footgun should separate ad-hoc structural queries from routine scans:

```text
footgun query       Explore a structural pattern
footgun scan        Run configured complexity rules
footgun rule test   Validate a rule against fixtures
footgun scanners    Inspect backend capabilities and availability
```

The names are illustrative, but the separation is important. A one-off query,
a maintained complexity rule, and an external profiler have different result
contracts and validation requirements.

Ast-grep's rule configuration suggests a useful future shape for Footgun rules:

```text
rule id
language/capability
pattern or structural query
severity/priority
claim template
assumptions
test fixtures
optional remediation hint
```

The `optional remediation hint` must not become an automatic patch. It is a
candidate transformation that requires behavior and performance validation.

Ast-grep's npm packaging is also a useful warning. Cross-platform precompiled
binaries can make a CLI feel dependency-free, but they add platform matrices,
release artifacts, and native-binary verification. Footgun should decide
whether to ship a pure Node runtime, optional native parser packages, or a
platform package strategy only after measuring distribution and startup needs.

## SCIP

DeepWiki describes SCIP as a language-neutral transmission format for code
intelligence. It represents documents, symbols, occurrences, source ranges,
definitions, references, implementations, and external symbols.

SCIP is a promising optional context layer for Footgun:

```text
finding location
  -> enclosing symbol
  -> callers and references
  -> implementations or overrides
  -> likely input and test paths
```

It can reduce the need for each language adapter to reinvent cross-file symbol
identity. It should be treated as an input adapter or index import, not as the
complexity model.

SCIP does not model:

- loop bounds or recurrences;
- data-structure operation costs;
- runtime distributions or profiles;
- memory, I/O, database, or rendering behavior;
- direct complexity/performance claims.

A SCIP-backed context result must therefore remain separate from scanner
evidence. “The finding has three callers” is repository context, not three
independent confirmations of a hotspot.

## GitContribute coverage result

Exact corpus lookups for `tree-sitter/tree-sitter`, `semgrep/semgrep`,
`ast-grep/ast-grep`, `sourcegraph/scip`, and `sourcegraph/scip-typescript`
returned no stored repository matches. This is an index-coverage result, not
evidence that those repositories lack source or project activity. DeepWiki was
available for all four and provided the architecture views above.

The existing GitContribute corpus remains useful for previously indexed
benchmark and tooling repositories, but it should not be used to conclude that
an unindexed project is absent or unmaintained.

## SARIF as the external static-scanner boundary

DeepWiki was available for `oasis-tcs/sarif-spec`. Its model provides a useful
interchange boundary for external static analyzers:

- `tool.driver` and extensions identify the producing tool and rule libraries;
- `ruleId` identifies the rule that produced a result;
- `locations` and `relatedLocations` preserve primary and contextual source
  locations;
- `fingerprints` and `partialFingerprints` support stable result identity and
  deduplication across runs;
- `invocations` preserve execution status and tool notifications;
- `fixes` can carry proposed edits without requiring Footgun to apply them.

Footgun should provide a SARIF importer before inventing one bespoke adapter
for every static analyzer. The importer should retain the original SARIF run
and map its results into Footgun findings with `scanner`, `rule`, `location`,
`related_evidence`, `status`, and provenance fields.

SARIF does not express Footgun's central claims by itself. Complexity estimates,
assumptions, empirical scaling, benchmark distributions, and semantic risks
need Footgun-owned extension properties or a sidecar investigation record.
The sidecar should reference the SARIF result by run, rule ID, and fingerprint
instead of replacing the standard data.

This gives the adapter strategy a clear order:

```text
external scanner
  -> SARIF (preferred)
  -> native adapter for non-SARIF output
  -> normalized Footgun finding
```

External outputs that are not SARIF remain supported, but each native adapter
must document why a SARIF conversion is unavailable and what evidence is lost.

## Workload isolation research

DeepWiki was available for `google/nsjail` and `containers/bubblewrap`.

NSJail offers Linux namespace isolation, user/group remapping, mount and PID
isolation, network namespaces, seccomp-bpf policies, `rlimit` controls, and
cgroup CPU/memory/process limits. Its operational contract depends on kernel
features, user-namespace helpers, cgroup configuration, and sometimes elevated
privileges.

Bubblewrap offers a lower-level namespace and filesystem toolkit: isolated
mount roots, selective read-only/read-write bind mounts, optional network/PID/
user namespaces, `PR_SET_NO_NEW_PRIVS`, and optional seccomp filters. DeepWiki
also highlights that its safety depends on the caller constructing a correct
policy; it is not a complete sandbox by itself.

### Implications for Footgun

Execution isolation should be an adapter capability, not an assumption of the
benchmark engine:

```text
workload
  -> execution policy
  -> host capability check
  -> optional sandbox adapter
  -> bounded process runner
  -> measurement and provenance record
```

The record must state whether a run was unsandboxed, namespace-isolated,
containerized, or otherwise constrained. It must include unavailable
capabilities and policy limitations. A sandbox failure should block the run or
require explicit user consent; it should not silently downgrade a high-risk
execution request.

The first safe default can remain static-only. When execution is introduced,
Footgun should prefer a declared local workload, bounded process lifetime,
controlled filesystem exposure, explicit network policy, output limits, and
process-tree cleanup. Cross-platform support will likely require different
adapters rather than pretending Linux namespace controls exist everywhere.

## Follow-up validation, not broad discovery

The targeted contract research is recorded in the
[integration contract note](integration-contracts.md). The architecture is
now strong enough to stop broad tool surveying. The remaining work is
validation of concrete decisions:

1. **CLI distribution:** compare a pure npm/Node package with optional native
   parser packages and platform-specific binary packages. Measure install,
   startup, offline behavior, cache invalidation, and upgrade safety.
2. **Adapter contract:** run host-owned contract tests against built-in,
   SARIF-import, and one native non-SARIF adapter.
3. **Repository context:** measure whether SCIP or a local index changes caller,
   input, and test-path resolution on representative repositories.
4. **Execution isolation:** validate host-specific process/resource adapters and
   record exactly which security properties remain unprovided.
5. **Evaluation corpus:** assemble labeled multi-language slices and pinned
   repository tasks, then report precision/recall and unknown coverage.
6. **Measurement adapters:** replay common benchmark bundles across hosts and
   preserve raw profiler/benchmark artifacts alongside normalized evidence.

There is no current need to research MCP architecture further. The target is a
`footgun` CLI distributed in the `footgun` npm package, with
`$footgun` teaching compatible agent hosts how to invoke and interpret it.
