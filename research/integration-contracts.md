# Integration contract research

Research pass: 2026-08-05.

This note answers the six architecture questions that remain after the broad
scanner, literature, and benchmark survey:

1. how scanner and adapter plugins should exchange information;
2. how repository context should be indexed and queried;
3. how explicitly requested workloads can be executed safely on different
   hosts;
4. how to build a labeled, multi-language evaluation corpus; and
5. how benchmark and profiler evidence can be compared without flattening
   different kinds of measurements into one score.

The recommendation is deliberately layered. `footgun` should have a small,
versioned host-owned adapter contract, import established interchange formats
where they already exist, use local indexing as a universal fallback, and
preserve raw evidence alongside normalized summaries. The
`$complexity-optimizer` skill should interpret those artifacts; it should not
become a second plugin runtime or evidence format.

## 1. Scanner and adapter plugin contract

### What the contract must solve

The adapter boundary has to handle very different producers:

- a built-in Tree-sitter rule that reads source files;
- an external static analyzer that emits SARIF;
- a compiler or language server that supplies symbols and references;
- a benchmark runner that emits repeated timings;
- a profiler that emits samples, counters, or trace events; and
- a host-specific process runner that supplies execution constraints.

These should not be forced into one overloaded `analyze()` method. A plugin
that can find a structural candidate does not necessarily know how to run a
workload, and a profiler should not be required to understand source-language
rules. The registry should expose capability-specific adapters that share
identity, availability, provenance, diagnostics, and artifact conventions.

### Proposed capability model

An adapter manifest should declare at least:

| Field | Meaning |
| --- | --- |
| `protocol_version` | Version of the host/adapter exchange contract |
| `id` and `version` | Stable adapter identity and release version |
| `tool` and `tool_version` | Underlying analyzer, runner, or profiler |
| `languages` | Language names, versions, and support tier |
| `capabilities` | Static scan, context, benchmark, profile, trace, or isolation features |
| `input_kinds` / `output_kinds` | Files, source trees, indexes, workloads, SARIF, profiles, and so on |
| `requirements` | Executables, runtimes, compilers, permissions, or services |
| `side_effects` | Read, execute, write, network, service, and resource behavior |
| `limits` | Parallelism, timeout, memory, output, and artifact constraints |
| `config_schema` | Versioned configuration shape, not an unbounded flag bag |
| `determinism` | Deterministic, seeded, environment-sensitive, or nondeterministic behavior |

The host should ask an adapter to `probe` before invoking it. A probe result
must distinguish `ready`, `unavailable`, `blocked`, and `incompatible`, with a
human-readable reason and a machine-readable recovery action. Missing optional
tools should be visible in the report, but should not make a static scan fail.

The execution operation should receive a structured request containing a
repository root, selected targets, revision or content digest, configuration
digest, requested capabilities, timeout, concurrency, and execution policy.
It should return a structured result envelope containing:

```text
schema_version
adapter and tool identity
request and configuration digests
status: complete | partial | unavailable | blocked | failed | cancelled
coverage: files, languages, rules, skipped targets, unknown regions
findings or evidence references
diagnostics: parse, timeout, permission, resource, and tool messages
raw artifacts and their digests
reproduction metadata and exit information
```

`partial` is a successful result with bounded omissions. `unavailable` means
the adapter could not run in the current environment. `blocked` means policy
prevented execution. `failed` means the adapter was invoked but did not
complete. These states must not be coerced into an empty result or a clean
scan. One failed adapter should not erase findings produced by other adapters.

### Static output and SARIF

SARIF is the preferred import boundary for external static analyzers. Its tool
identity, rule IDs, source locations, related locations, invocation status,
fingerprints, and optional fixes already cover much of the interchange
problem. Footgun-specific fields should be kept in an extension or linked
investigation sidecar:

- estimated complexity claim and claim class;
- assumptions and semantic conditions;
- context/index sources;
- empirical scaling and benchmark evidence references;
- behavior-test results;
- risk, confidence, and unknown coverage.

The import path should be:

```text
external analyzer -> SARIF importer -> Footgun finding
```

Native adapters remain appropriate for tools with no SARIF output and for
benchmarks, profilers, indexes, and sandboxes whose native formats carry
important information. A native adapter must state what it preserves and what
it cannot represent.

### Adapter process boundary

For an external executable, the host should prefer an argument array over a
shell command string, a declared working directory, an explicit environment
allowlist, bounded stdout/stderr and artifact sizes, cancellation, and process
tree cleanup. JSON over stdin/stdout or a declared result file is easier to
replay than scraping terminal prose. The host owns timeouts and resource
limits; an adapter may request stricter limits but should not silently weaken
them.

The plugin contract should not assume that third-party adapters are trusted.
Installation and invocation need separate trust states. A static SARIF import
can be treated as a data-read operation, while running an adapter executable
requires the same disclosure and policy checks as running a workload.

### What should be tested

Every adapter should pass host-owned contract tests for:

- manifest validation and capability discovery;
- deterministic request and result serialization;
- repository-relative locations and source-span conventions;
- complete, partial, unavailable, blocked, failed, and cancelled states;
- malformed output, timeout, crash, permission, and oversized-output recovery;
- artifact digest and provenance preservation;
- no silent shell expansion or working-directory escape; and
- stable finding identity and deduplication behavior.

The host should not test private adapter implementation details. It should test
the observable contract and maintain a small adapter-specific fixture suite for
semantic quality.

## 2. Repository context: SCIP, Kythe, LSIF, and local indexing

### What context is actually needed

Complexity investigation usually needs a small set of repository facts:

```text
finding span -> enclosing symbol -> callers and references
             -> implementations/overrides
             -> input construction and tests
             -> benchmark or request path
```

That is narrower than building a universal compiler database. Context should
be requested only when it helps explain a candidate or choose a workload.
Index freshness and coverage are part of the evidence, not an implementation
detail.

### Comparison

| Source | Strongest contribution | Cost or limitation | Footgun position |
| --- | --- | --- | --- |
| Local syntax index | Always available file, symbol, loop, call-site, and import hints | Weak alias/type resolution; dynamic dispatch remains unknown | Required fallback for every language with a parser |
| SCIP | Batch symbols, occurrences, definitions, references, implementations, enclosing symbols, and external symbols in a compact protobuf index | Requires a language-specific indexer and build/configuration context; does not encode complexity, runtime, or performance | First optional semantic-context importer |
| Kythe | Extensible language-neutral graph, compiler/build metadata, cross-language links, callgraph-related edges, and a verifier | More graph/storage/indexer infrastructure; semantic quality depends on instrumented indexers and build facts | Later adapter for large or cross-language ecosystems, especially where Kythe data already exists |
| LSIF | Persisted navigation graph for definitions, references, hover, and related language-server information without a live source checkout | Navigation-oriented rather than a complexity model; ecosystem and index freshness vary; graph may omit analysis-specific relationships | Import only when an existing LSIF artifact is available; not the primary index format |
| Live LSP | Targeted, language-native lookup using the current workspace configuration | Session startup, build state, latency, and server-specific behavior; not inherently a durable index | Optional targeted resolver for an unresolved finding |

The [Kythe overview](https://www.kythe.io/docs/kythe-overview.html) describes
its graph as a language-agnostic representation of build/compiler metadata and
cross-references, while its [schema](https://www.kythe.io/docs/schema/) defines
relationships such as definitions, references, calls, overrides, and generated
code. The [LSP site](https://microsoft.github.io/language-server-protocol/)
describes LSIF as a graph format for storing programming-artifact information
for navigation. These are useful context sources, but neither is a substitute
for a complexity or benchmark evidence model.

SCIP should be the first batch import because its document/occurrence model is
close to the caller and enclosing-symbol queries Footgun needs without making
the core understand every compiler database. Kythe should remain a future
high-value adapter where its graph already exists. LSIF should be a compatible
input, not a required build step. A live LSP request is a useful last-mile
resolver, but its answer should be marked workspace- and server-dependent.

### Context evidence contract

Each context result should record:

```text
source: local-syntax | scip | kythe | lsif | lsp | language-native
schema and indexer versions
repository revision or source digest
index artifact digest and creation time
workspace/build configuration identity
resolved facts and unresolved queries
coverage and stale/partial status
```

“No callers found” is only a negative fact if the index proves complete
coverage for that symbol and revision. Otherwise the result is “no callers
returned by this context source” and the report must retain the uncertainty.

### Recommended context progression

1. Build a local syntax index during every scan, with file and source-span
   identity that can be reproduced without external tools.
2. Import SCIP when a compatible index is supplied or can be produced by an
   explicitly selected indexer.
3. Ask a live LSP or language-native adapter for targeted missing facts only
   when the user accepts its environment requirements.
4. Add Kythe integration after a concrete repository ecosystem demonstrates
   that its cross-language or build-aware graph changes investigation outcomes.

This keeps repository context useful on small projects and avoids requiring a
full semantic build before the scanner can report structural candidates.

## 3. Safe execution across hosts

The static scanner is read-only and should not execute repository code. A
measurement command is a separate, explicit operation with a declared
workload, policy, timeout, and artifact destination.

### Capability matrix

| Host/backend | Useful controls | Important boundary | Product policy |
| --- | --- | --- | --- |
| Linux + Bubblewrap | Mount/user/PID/network namespaces, read-only binds, `no_new_privs`, optional seccomp | A policy toolkit, not a complete sandbox; flags and kernel configuration matter | Optional constrained runner after preflight; record the exact policy |
| Linux + NSJail | Namespaces, seccomp-bpf, rlimits, cgroups, process and resource limits | Kernel features, user-namespace helpers, cgroups, and privileges vary | Stronger optional runner; fail closed when requested controls are unavailable |
| Windows + Job Objects | Process-tree grouping, termination, CPU/process-time, memory/working-set and active-process accounting | Resource/process control is not a complete filesystem/network security sandbox; child breakaway needs handling | Native process/resource adapter; pair with explicit filesystem/network policy |
| macOS | Explicit user authorization, process limits, containers/VMs where available | Apple App Sandbox is entitlement-based for signed applications and embedded CLIs, not a general arbitrary CLI jail | Do not claim generic App Sandbox protection; use a declared local-exec or container/VM profile |
| OCI/Docker/container | Reproducible image, lifecycle, namespaces, mounts, cgroups, explicit network and resource settings | Containers have no resource constraints by default; Docker Desktop adds VM/WSL2/network policy differences | Preferred reproducible runner when an image is supplied; record runtime, image digest, and limits |

The [Windows Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
supports the process-tree and resource-control distinction. Docker's
[resource constraints](https://docs.docker.com/engine/containers/resource_constraints/)
documentation explicitly notes that containers are not resource-constrained by
default, and the [OCI runtime specification](https://specs.opencontainers.org/runtime-spec/)
defines a standard lifecycle/configuration boundary rather than promising one
uniform host security model. Apple's [App Sandbox documentation](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
is likewise an entitlement and signing model, not a generic switch for any
local command.

### Execution profiles

The CLI should expose a visible profile rather than a vague `--safe` flag:

```text
static-read-only
  No repository execution. Source and metadata reads only.

local-exec
  Explicit command, user-approved, bounded process tree, controlled cwd/env,
  output and timeout limits. Security isolation is not promised.

constrained-exec
  Host-specific namespaces/job/resource controls passed by a verified adapter.
  Missing controls fail closed.

container-exec
  Declared OCI image and digest, explicit mounts, network policy, resources,
  process limits, and cleanup.
```

Every run should record the requested profile, actual backend, host capability
probe, policy digest, downgrade/omission reasons, command identity, process
cleanup result, and artifact locations. A request for constrained execution
must not silently fall back to unsandboxed execution.

### Cross-platform test cases

The runner evaluation should exercise command arguments containing spaces and
metacharacters, nested child processes, cancellation, timeouts, large output,
nonzero exits, file permission errors, symlinks/reparse points, path traversal,
network denial, read-only mounts, and cleanup after interruption. Tests should
also prove what the adapter does *not* isolate. A green process-limit test is
not evidence of filesystem or network isolation.

## 4. Labeled multi-language evaluation corpus

The corpus must measure both detection quality and the strength of the claim
attached to a detection. A source snippet can be a true positive for “nested
iteration exists” while being a false positive for “this is an observed hot
path.” Those labels must not be conflated.

### Corpus tiers

| Tier | Purpose | Example contents |
| --- | --- | --- |
| Structural fixtures | Fast rule precision/recall and location checks | Loops, callbacks, recursion, repeated search/sort, allocations, comments, strings |
| Semantic fixtures | Alias, type, mutation, control-flow, and framework conditions | List vs set membership, iterator consumption, dynamic dispatch, ORM/query pagination |
| Language-version fixtures | Parser and syntax compatibility | Python/JS/TS/Go/Java/Rust/C++ version differences and embedded languages |
| Repository fixtures | Context and build discovery | Small multi-file projects with callers, tests, manifests, generated/vendor paths |
| Workload fixtures | Empirical scaling and behavior checks | Parameterized inputs with known growth, duplicates, ordering, errors, permissions, caching |
| Real repository tasks | External validity | Pinned optimization tasks with executable workloads and independent correctness checks |

Each fixture should have a manifest containing language and version, source
digest, expected parser status, rule labels, semantic conditions, provenance
and license, generated/vendor status, and optional workload/equivalence
oracles. Real-repository tasks must remain separate from synthetic fixtures so
high synthetic recall cannot be mistaken for repository-level effectiveness.

### Four-way rule outcomes

Borrow the useful distinction in [ast-grep's rule testing
model](https://ast-grep.github.io/guide/test-rule.html):

```text
valid + reported       expected finding
valid + not reported   missed finding
invalid + reported     false positive/noisy finding
invalid + not reported expected silence
```

Add a fifth outcome for `unsupported/unknown` when the input is intentionally
  outside the adapter's capability. It should be counted as unknown coverage, not
as a true negative.

For each finding kind, record at least:

- expected source span or span tolerance;
- structural label and semantic label;
- acceptable claim class and assumptions;
- expected confidence/status;
- whether a context lookup should resolve callers or inputs;
- whether a workload is required to validate the claim; and
- known non-goals and ambiguity cases.

Fixtures should specifically target nested syntax, callbacks, comments,
strings, aliases, unknown collection types, mutation after index creation,
generator/iterator behavior, dynamic dispatch, parse errors, generated code,
and framework calls whose cost depends on deployment or database state.

### Quality gates and contamination control

CodeQL's [custom query testing workflow](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/test-custom-queries)
is a useful model: query tests keep example code separate from the query,
store expected results, compare actual and expected output, and fail on an
unexpected change. CodeQL also separates query tests from library tests and
uses pinned pack dependencies. Footgun should adopt the same separation for
scanner rules, context adapters, and workload oracles.

The corpus evaluator should report precision, recall, F1, location accuracy,
parse coverage, unsupported coverage, runtime, memory, and output stability by
language and rule. It should fail on unexpected alert changes, but expected
changes require a reviewed manifest update with a reason.

Repository tasks require additional controls:

- pin commit, dataset, dependency, image, and configuration digests;
- record whether a case is upstream reproduction, authored task, or source
  reference;
- keep hidden correctness or performance oracles out of the agent-visible
  corpus;
- reject evidence symlinks or paths escaping the verifier workspace;
- normalize paths and redact credentials before committing reports; and
- separate rule accuracy from workload success and from patch quality.

### Promotion lifecycle

Rules should move through explicit maturity states:

```text
experimental -> fixture-validated -> repository-validated -> supported
```

Promotion should require the applicable positive/negative fixtures, no known
high-severity false positive class left unreported, stable source locations,
bounded scan cost, and documented assumptions. A rule can remain useful in an
experimental pack without being advertised as broadly reliable.

## 5. Common benchmark and profiler evidence contract

The contract should normalize metadata and comparisons, not erase native
formats. Keep the original pyperf, ASV, hyperfine, Google Benchmark, Criterion,
JMH, pprof, Perfetto, perf, or other artifact and store its digest. A summary
without the raw distribution is not sufficient for a performance claim.

### Benchmark observation

The common benchmark record should contain:

```text
schema_version: footgun.evidence/v1
kind: benchmark-observation
run_id
subject: baseline | candidate, revision/artifact identity and digest
workload: stable id, command identity, input parameters, dataset/fixture digest
measurement: metric, unit, direction, values, warmups, loops, repetitions
summary: min, max, median, MAD/stddev, quantiles, mean, outliers, uncertainty
environment: OS, architecture, CPU model/count, runtime/compiler, container/VM
runner: tool/adapter versions, timer, calibration, timeout, resource policy
behavior: test suite/invariant status and artifact references
status: complete | partial | failed | inconclusive | unavailable
provenance: timestamps, source/config digests, raw artifact digest and path
```

The exact statistic set can vary by tool, but raw samples, units, timer,
warmups, repetition count, and environment must not be dropped. Values should
be normalized only when the normalization rule and loop count are retained.
Python's [pyperf documentation](https://pyperf.readthedocs.io/en/latest/)
illustrates the useful vocabulary: calibrated loops and warmups, repeated runs,
machine metadata, normalized per-loop values, medians/MAD, percentiles, and
outlier handling.

### Scaling evidence

An empirical complexity record is a benchmark series, not a single timing:

```text
sweep: input parameter names, ordered points, dataset generation and digest
observations: benchmark records for each point
candidate models: e.g. linear, n log n, quadratic, exponential, constant
fit: selected model, parameters, residuals, range, uncertainty, selection rule
limitations: finite range, setup cost, cache effects, noise, censored failures
```

The model is an estimate over the declared range. A good curve fit does not
prove the program's asymptotic bound, especially if the inputs do not exercise
the relevant branch or the benchmark includes I/O and setup work.

Keep `empirical-scaling` separate from `constant-factor`. A candidate can have
the same growth curve but a useful constant-factor reduction, or a better curve
that is slower at every tested size. The report should show both.

### Profile and trace evidence

Profiles are not benchmark samples. A common profile envelope should record:

```text
kind: sampled-profile | counter-profile | trace | memory-snapshot
profile type and native format
subject/build and symbolization artifacts
clock and timestamps or sampling period/frequency
process/thread/CPU identity and tags
sample/counter/trace payload reference and digest
overhead estimate, dropped data, permissions, and collection limits
source mapping confidence and unresolved frames
```

[pprof](https://github.com/google/pprof) uses a profile protocol containing
sampled call stacks and symbolization information and supports aggregation and
comparison. [Perfetto](https://perfetto.dev/docs/) models timestamped slices,
counters, scheduling/process events, and SQL-queryable trace data. These are
different native models; Footgun should normalize their metadata and selected
hotspot summaries while preserving the original artifacts.

The report must state whether a profile is sampled or exact, what overhead it
adds, what was not observable, and how source frames were symbolized. A hot
stack in a sampled profile is evidence of observed resource attribution under
one workload, not proof of total program cost or a universal bottleneck.

### Baseline/candidate comparison

A comparison is admissible only when it binds:

```text
same workload and input/dataset digest
same behavior/equivalence result
same or explicitly contrasted environment
same metric, unit, timer, and runner semantics
raw distributions for both subjects
effect size and uncertainty/noise summary
resource and failure trade-offs
```

The result should classify the observation as improved, regressed, unchanged,
inconclusive, or incomparable. It should not choose a winner from a mean-only
comparison when distributions overlap or behavior evidence is missing.

## Decisions and remaining validation

The research supports these design decisions:

1. Keep the plugin registry capability-oriented and host-owned; do not create a
   universal plugin object with hidden side effects.
2. Prefer SARIF for imported static findings, SCIP for optional batch semantic
   context, and a local syntax index as the always-available fallback.
3. Treat Kythe, LSIF, live LSP, profilers, and sandboxes as optional adapters
   whose coverage and host requirements are recorded explicitly.
4. Keep static scan and workload execution as separate commands and policy
   profiles. There is no cross-platform generic `--safe` guarantee.
5. Build rule-quality gates from small labeled fixtures first, then add pinned
   repository tasks and workloads with independent behavior oracles.
6. Normalize benchmark/profile evidence without collapsing raw distributions,
   native artifacts, uncertainty, or environment provenance.

The next work is validation, not another broad ecosystem survey: write the
adapter contract tests, construct representative corpus slices, replay the
same benchmark bundle on supported hosts, and measure whether SCIP/context
lookups change investigation decisions. No MCP server is needed for this
CLI-plus-skill design.

## Primary references

- [SCIP protocol](https://github.com/sourcegraph/scip)
- [Kythe documentation](https://www.kythe.io/docs/)
- [Language Server Protocol and LSIF](https://microsoft.github.io/language-server-protocol/)
- [SARIF specification](https://github.com/oasis-tcs/sarif-spec)
- [ast-grep rule tests](https://ast-grep.github.io/guide/test-rule.html)
- [CodeQL custom query tests](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/scan-from-the-command-line/test-custom-queries)
- [Tree-sitter](https://github.com/tree-sitter/tree-sitter)
- [Semgrep documentation](https://semgrep.dev/docs/)
- [Bubblewrap](https://github.com/containers/bubblewrap)
- [NSJail](https://github.com/google/nsjail)
- [OCI runtime specification](https://specs.opencontainers.org/runtime-spec/)
- [pyperf](https://pyperf.readthedocs.io/en/latest/)
- [pprof](https://github.com/google/pprof)
- [Perfetto](https://perfetto.dev/docs/)
