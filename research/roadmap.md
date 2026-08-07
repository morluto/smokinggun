# Prioritized roadmap

The order below reflects impact, confidence, reviewability, and the current
release state. It keeps each contribution focused on one outcome.

## Completed foundation

The release foundation is implemented: `smokinggun@1.0.0` has a pinned lockfile,
grammar digest verification, package allowlist checks, an explicit skill
installer, CLI smoke coverage, Vite+ and Vitest gates, and a hosted Node 22/24
Linux/macOS/Windows CI matrix.

## P1 — precision and report honesty

### Scanner and evidence contract

Findings, coverage, provenance, assumptions, evidence, status, and stable IDs
are versioned in `FindingV1` and `ScanReportV1`. The report says `candidate` or
`unvalidated` when it has no type, caller, workload, or measurement evidence.

### Current scanner scope

Structural rules mask comments and strings and record candidate assumptions.
Tree-sitter provides syntax coverage for 14 languages, and TypeScript semantic
facts are compiler-backed. Unsupported semantic claims remain explicit rather
than being inferred from syntax alone.

### Adapter and context scope

SARIF and SCIP imports, one-shot external adapter manifests, capability states,
repository inventory, interpreter-free Python semantic facts, standard
benchmark JSON normalization, pprof summaries, bounded Perfetto query
summaries, explicit trace-processor CSV ingestion, bwrap/nsjail runner paths,
candidate-write workspaces, and parameterized scaling measurements are
implemented. Framework, database, and service semantics remain explicit
optional adapter work.

## P2 — repository context and hybrid measurement

### Remaining evidence work

#### Repository behavior

The first inventory and compiler-backed context pass now records manifests,
tests, benchmarks, definitions, references, and calls. Remaining work is
deeper caller provenance, input-source discovery, query/render boundaries, and
cache invalidation. This stage should continue to produce structured unknowns
when the repository does not expose the information.

#### Controlled empirical validation

Support a declared benchmark command with setup, warmup, repetition count,
timeout, input generator, and environment fingerprint. Compare baseline and
candidate outputs before timing, collect raw samples, use robust summaries, and
report uncertainty. For scaling claims, vary one named input dimension at a
time and fit only classes supported by the data. Include stress conditions
such as ordering, duplicate density, graph shape, cache state, and failure
paths; retain wall time separately from instruction/allocation/I/O signals and
identify the intended versus actually exercised path.

Select the measurement adapter by runtime boundary: pyperf/pytest-benchmark
for Python, Criterion/Google Benchmark/JMH for language-native microbenchmarks,
hyperfine or ASV for subprocess/revision comparisons, query-plan tools for
databases, and profiling/tracing for services. These adapters contribute
evidence; none replaces the repository behavior oracle.

#### Cross-machine replay for important claims

For performance-sensitive changes, rerun the same workload on at least two
declared environments or mark the result machine-specific. Preserve raw data
and the measurement protocol so a reviewer can replay it.

## P3 — research-heavy features

These should wait until P0–P2 produce trustworthy evidence:

- interprocedural call graphs and loop-bound reasoning;
- recursion, amortized complexity, graph algorithms, and allocation lifetime;
- database query plans, network timing, rendering traces, and cache behavior;
- learned complexity ranking models;
- automatic optimization edits and search over candidate patches.

Each of these can increase apparent sophistication while making false
confidence harder to detect. They need labeled real-repository tasks, a stable
behavior oracle, and measured baselines before they should drive edits.

## Recommended next contribution

The research direction is now the implemented conservative evidence-broker
architecture. The next work should add richer service/database adapters,
cross-machine replay evidence, and prove the hosted release lanes without
weakening the explicit unavailable states.

This changes the emphasis from “add more heuristics” to “make every heuristic
auditable and upgradeable.” Packaging correctness is still P0 because users
must receive the artifact that the repository claims to support; the next
research-heavy feature is the evidence schema, not an automatic optimization
edit.
