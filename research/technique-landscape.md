# SmokingGun technique and resource landscape

This note records the redesign space for the scanner. It is research output,
not an implementation proposal that has already been applied. The central
distinction is between finding a syntactic pattern, proving an asymptotic
bound, measuring an execution, and deciding whether a change is safe for a
repository workload.

## What the current scanner actually establishes

The labeled corpus contains four small cases. The current regression gate
reports:

| Signal | Precision | Recall | What the result means |
| --- | ---: | ---: | --- |
| Collection operation in iteration | gated | gated | TypeScript structural and semantic candidates are checked against positive and negative fixtures. |
| Membership/search in iteration | gated | gated | Unknown collection types remain candidates; known indexed collections are not promoted. |
| Nested loop | gated | gated | The corpus covers a TypeScript nested iteration shape. |
| Callback/nested iteration | not measured | not measured | Broader callback coverage remains an explicit corpus expansion item. |
| Sort in iteration | not measured | not measured | The rule is shipped, but the current corpus does not claim broad accuracy. |

These measurements support a conservative role: the scanner is a candidate
generator. It does not prove an `O(...)` bound, establish that a call is
reachable on a production path, or show that an optimization improves the
user's workload.

## Optimization technique map

| Technique | Static candidate signal | Useful validation | Semantic hazards to preserve |
| --- | --- | --- | --- |
| Pre-index repeated membership | A membership/search operation is inside an iteration; the right-hand collection is list-like or unknown. | Scale the outer and collection sizes independently; compare list/set/dict variants. | Equality and hashing behavior, duplicate handling, ordering, mutation, memory, and unhashable values. |
| Replace nested scans with an index, grouping, hash join, or sweep | Nested loops, nested comprehensions, callbacks inside callbacks, or repeated filters. | Use adversarial distributions, empty inputs, duplicates, and both sparse and dense matches. | Stable output order, one-to-many matches, early exits, mutation, and worst-case versus average-case behavior. |
| Hoist or replace repeated sorting | Sort call dominated by a loop or repeated call path. | Benchmark already-sorted, reverse-sorted, duplicate-heavy, and streaming inputs. | Intermediate ordering requirements, comparator side effects, stability, and memory lifetime. |
| Memoization, dynamic programming, or iterative reformulation | Recursive self-call, repeated call with the same apparent state, or overlapping subproblems. | Generate trees/graphs with shared subproblems and measure state growth; test recursion limits. | Mutable arguments, cache invalidation, identity versus equality, memory growth, cycles, and exceptions. |
| Batch or preload I/O | Query, request, filesystem, or RPC-looking call under iteration. | Count calls as well as wall time; run realistic latency and failure simulations. | Authorization per item, filters, pagination, transaction boundaries, rate limits, retries, partial failure, and response order. |
| Move derived work out of render/request paths | Collection transform in a component or request handler. | Profile realistic rerender/request frequencies and cache hit/miss distributions. | Dependency invalidation, stale data, user-specific state, rendering order, and memory retention. |
| Reduce allocation and data movement | Repeated copies, conversions, concatenations, serialization, or materialization in a loop. | Measure peak memory, allocation count, and throughput at representative sizes. | Aliasing, mutation visibility, lifetime, ownership, and error cleanup. |
| Improve locality, vectorize, parallelize, or tune the toolchain | Hot loop with regular access, large arithmetic body, or a profile showing CPU/cache/parallel slack. | Hardware-specific counters and repeated end-to-end workloads on every supported target. | Numerical precision, scheduling, contention, portability, determinism, startup cost, and energy. |

The scanner should present the first column as a hypothesis and attach the
second and third columns as questions for the repository investigation. The
suggestion alone is not an optimization instruction.

## Complexity models that must not be conflated

“Complexity” is not one scalar. The report needs a declared model before it can
interpret a candidate or a benchmark. The same code can be linear in records,
quadratic in a second dimension, output-sensitive in the number of matches,
and dominated by network latency in production.

| Model | What is measured or proved | Typical optimization question | Required caveat |
| --- | --- | --- | --- |
| Worst-case asymptotic | A bound as named input dimensions grow under adversarial inputs. | Can repeated scans become an index, join, sort+scan, or dynamic-programming state? | The input measure and data-structure assumptions must be explicit; a fitted curve is not a proof. |
| Average/expected or randomized | Expected work under a stated distribution or randomized algorithm. | Does hashing, sampling, randomized pivoting, or a workload distribution change expected cost? | The distribution, seed, collision behavior, and tail risk must be recorded. |
| Amortized | Average cost over a sequence, often justified by a potential or accounting argument. | Can resize/rebuild/flush costs be paid across operations rather than charged to one call? | Per-operation worst cases still matter for latency-sensitive callers; a benchmark of isolated calls misses the sequence. |
| Output-sensitive | Work as a function of input size and output size, such as `O(n + k)`. | Can filtering or joins avoid scanning work when few results are requested? | Output cardinality, duplicates, ordering, and early termination must be part of the workload family. |
| Parameterized | Cost in a main size `n` plus a parameter `k`, where exponential dependence may be acceptable only for small `k`. | Is the expensive dimension a bounded number of labels, columns, patterns, or graph width? | Do not collapse `k` into `n`; the parameter's operational range and input source must be visible. |
| External-memory/cache-aware | Transfers between cache, memory, disk, or network, often modeled in blocks or bytes. | Can locality, batching, indexing, layout, or chunking reduce transfers? | Wall time can change with cache state, storage, page size, and hardware; CPU-only counts are incomplete. |
| Streaming/online | One-pass work, working memory, latency, and update cost as data arrives. | Can materialization be removed, or can a sketch/window/index bound memory? | Backpressure, ordering, replay, exactness, and failure recovery are semantic constraints. |
| Parallel/GPU | Work, span/critical path, communication, synchronization, occupancy, and transfer. | Can independent work be fused, tiled, vectorized, or scheduled across workers? | A lower work count can lose to synchronization or transfer overhead; correctness and determinism need separate checks. |
| System/queueing | Service time, concurrency, queue wait, throughput, tail latency, and resource saturation. | Is the bottleneck CPU, lock contention, database, network, disk, or a downstream queue? | A source-level Big-O label cannot explain contention or tail latency without system measurements. |
| Structural/maintainability | Cyclomatic complexity, logical lines, nesting, coupling, or cognitive load. | Should the code be decomposed or made easier to reason about? | These metrics can predict review/test burden but do not establish runtime or memory complexity. |

The scanner should therefore report a *complexity claim type* alongside its
pattern. A nested loop may justify a worst-case candidate, while a database
call requires an external-system and workload claim; a recursive call may need
an amortized or recurrence model; a renderer may need a work-per-render and
render-frequency model. The claim type determines which evidence is admissible.

## Optimization families beyond the current pattern signals

The current scanner mostly finds local repeated work. The broader algorithmic
landscape includes transformations that may not contain a suspicious nested
loop or recognizable API call at all:

| Family | Common transformation | What to vary when validating | Main semantic/performance risk |
| --- | --- | --- | --- |
| Prefix/suffix and range aggregation | Replace repeated range scans with prefix sums, difference arrays, Fenwick trees, or segment trees. | Query count, update/query ratio, range lengths, empty ranges, integer overflow, and online versus offline use. | Update semantics, inclusivity, overflow, memory, and stale derived state. |
| Ordering and two-pointer methods | Sort once, binary-search, merge sorted streams, sweep events, or use monotonic stacks/queues. | Already sorted, reverse sorted, ties, duplicates, stable ordering, and early exits. | Sort stability, comparator side effects, mutation, and changed output order. |
| Divide-and-conquer and convolution | Split work recursively, use FFT/convolution, or exploit batch algebra. | Input sizes around recursion/base-case thresholds, numeric ranges, prime/modulus choices, and padding. | Numerical error, recursion depth, crossover constants, and implementation/library overhead. |
| Dynamic programming and state compression | Memoize overlapping subproblems, use bottom-up tables, bitsets, or reduce state dimensions. | Shared-subproblem density, state cardinality, cache hit rate, memory limits, and reconstruction paths. | Cache invalidation, mutable inputs, state-key equality, memory blow-up, and lost witness/order information. |
| Graph and union-find structures | Replace repeated reachability/search with adjacency indexes, BFS/DFS, Dijkstra variants, topological order, SCC, or disjoint-set union. | Sparse/dense graphs, disconnected/cyclic inputs, weights, repeated queries, and adversarial topology. | Directedness, duplicate edges, negative weights, recursion limits, component identity, and determinism. |
| String and text indexing | Use tries, prefix tables, KMP/Z, rolling hashes, suffix structures, token indexes, or compiled regexes. | Alphabet size, repetitive/adversarial text, Unicode normalization, pattern count, and match overlap. | Collision probability, normalization/locale, regex backtracking, memory, and match ordering. |
| Data-structure replacement | Choose a hash table, ordered tree, heap, deque, bloom filter, bitmap, or specialized index. | Hit/miss ratio, key distribution, resize behavior, memory pressure, concurrency, and deletion workload. | Equality/hash contracts, false positives, ordering, iteration stability, and worst-case collision behavior. |
| Batch/vector/columnar execution | Fuse loops, vectorize arithmetic, use SIMD/BLAS, columnar layouts, or batch RPC/database work. | Batch size, alignment, tail batches, data types, transfer size, and cold versus warm state. | Numerical precision, latency versus throughput, tail behavior, boundary handling, and hidden allocation. |
| Incremental and differential computation | Recompute only affected outputs, cache derived values, or update a materialized view. | Change locality, invalidation frequency, cache hit/miss, dependency graph size, and restart/replay behavior. | Stale values, dependency omissions, memory retention, ordering, and failure recovery. |
| Streaming, sampling, and sketches | Bound memory with windows, reservoir sampling, HyperLogLog, Count-Min, or approximate indexes. | Stream length, distribution drift, burstiness, error tolerance, replay, and memory budget. | Approximation error, mergeability, eviction, backpressure, and exactness requirements. |
| Concurrency, scheduling, and locality | Parallelize independent work, shard state, reduce locks, improve placement, or overlap I/O and CPU. | Worker count, contention, queue depth, skew, cancellation, failure, and hardware topology. | Races, deadlocks, nondeterminism, tail latency, oversubscription, and higher coordination cost. |

These families suggest two evaluation rules. First, a scanner finding is only
one route into optimization; a profile or repository workload may reveal an
opportunity with no obvious local pattern. Second, semantic checks must be
family-specific: a set conversion tests hashing/order/mutation, while a graph
rewrite tests topology/weights, and a cache or incremental rewrite tests
invalidation and restart behavior.

## Tool and research landscape

| Resource | What it adds | What it cannot establish for this project |
| --- | --- | --- |
| Python `ast` | Exact Python syntax, scopes that the visitor models, and low-dependency distribution. | No type facts, call graph, runtime sizes, or semantics for dynamically dispatched calls. |
| [Tree-sitter](https://tree-sitter.github.io/) | Multi-language concrete syntax trees, source spans, error recovery, queries, and incremental reparse support. | It is a parser, not a type checker or bound analyzer; semantic facts require additional adapters and scope analysis. |
| [Semgrep](https://semgrep.dev/docs/) | Declarative structural rules, metavariables, boolean composition, and `pattern-inside` context matching. | Structural matching and ordinary community analysis do not prove input-size bounds, collection complexity, or measured bottlenecks. |
| [Lizard](https://github.com/terryyin/lizard) and [thoughtbot/complexity](https://github.com/thoughtbot/complexity) | Maintained examples of language coverage, code-shape metrics, repository traversal, and machine-readable reports. | Cyclomatic/indentation/shape scores are maintainability signals, not algorithmic runtime complexity. |
| [Sinn, Zuleger, and Veith, bound and amortized analysis](https://arxiv.org/abs/1401.5842) | A formal route from abstract program models and ranking functions to loop and amortized bounds. | The analysis is a research-grade proof system with restricted models; it is not a drop-in replacement for a mixed-language repository scanner. |
| [Automatic Amortized Resource Analysis with regular recursive types](https://arxiv.org/abs/2304.13627) | A type-and-potential approach for symbolic resource bounds over recursive data structures. | It needs a typed intermediate language and still has an undecidability-driven incompleteness boundary. |
| [Scalene](https://github.com/plasma-umass/scalene) | Python CPU, memory, and copy-volume attribution with function/line targeting. | Sampling and Python focus do not infer asymptotics or cover arbitrary languages and external systems. |
| [pyperf](https://github.com/psf/pyperf) | Calibration, process isolation, warmups, repetitions, system metadata, and statistical checks for Python benchmarks. | It does not choose representative inputs, prove semantic equivalence, or remove workload and environment bias. |
| [pytest-benchmark](https://pytest-benchmark.readthedocs.io/en/stable/) | A pytest-native benchmark fixture with calibrated rounds, explicit warmups/iterations, saved comparisons, and outlier statistics. | It is a harness primitive; repository setup, input families, correctness checks, and cross-machine policy remain project-specific. |
| [pyperformance](https://github.com/python/pyperformance) | A maintained model for real-world benchmark suites and reproducible Python performance comparisons. | Its suite is Python-specific and does not automatically map a static candidate to a workload. |
| [CodeQL](https://codeql.github.com/docs/) | Represents code as queryable data and supports language/framework libraries, AST-oriented queries, control-flow context, call-graph/data-flow analysis, and reusable custom queries. | It is a semantic query and security-analysis platform, not an asymptotic-complexity prover or runtime profiler. Call graphs can be approximate, and external systems remain outside the database unless modeled. |
| [airspeed velocity (ASV)](https://asv.readthedocs.io/en/latest/) | Runs parameterized benchmarks across revisions and isolated environments, records environment metadata, detects regressions, and supports historical comparisons. | It gives a strong revision/environment experiment shell but does not choose representative inputs, establish functional equivalence, or explain why a benchmark changed. |
| [hyperfine](https://github.com/sharkdp/hyperfine) | Provides warmups, repeated subprocess timing, parameter scans, outlier/interference reporting, and JSON/CSV/Markdown export; useful for black-box commands. | It is not a significance-test or asymptotic-inference engine. Shell startup dominates very fast commands, and subprocess timing cannot attribute cost to source locations or prove behavior. |
| [Google Benchmark](https://github.com/google/benchmark) | C++ fixtures, parameterized arguments, dynamically sized iterations, repetition summaries, compiler barriers, and structured JSON/CSV output. | Iteration-level stability does not establish representative repository behavior; fixture setup, compiler flags, CPU frequency, cache state, and external I/O still need policy. |
| [Criterion.rs](https://github.com/bheisler/criterion.rs) | Rust warmups, repeated sampling, outlier analysis, bootstrap/statistical comparison, parameterized inputs, throughput labels, and saved JSON estimates. | Statistical evidence is for the measured benchmark and comparison; it does not prove asymptotic behavior, semantic equivalence, or transfer across workloads and hardware. |
| [JMH](https://github.com/openjdk/jmh) | JVM-aware forks, warmups, measurement iterations, benchmark modes, parameterized state, and profiler/black-hole patterns that reduce JIT and dead-code-elimination errors. | A reliable microbenchmark still does not represent an entire service. JVM, compiler, garbage collector, allocation state, and fork configuration must remain part of the evidence. |
| [async-profiler](https://github.com/async-profiler/async-profiler) | Low-overhead Java sampling for CPU, heap/native allocation, locks, and hardware/software counters, including native and kernel frames. | Sampling identifies where a running workload spends resources; it does not infer asymptotic bounds, prove causality, or cover non-Java applications without the relevant mode and permissions. |
| [Linux `perf` events](https://www.kernel.org/doc/html/latest/userspace-api/perf_event_open.html) | Kernel-backed hardware/software counters, sampling, tracepoints, and call-graph evidence for native workloads; security and machine configuration are part of the measurement context. | Counter availability, permissions, multiplexing, symbolization, and sampling bias vary by kernel and hardware; a profile is not an asymptotic proof or a behavior oracle. |
| [Go diagnostics and `pprof`](https://go.dev/doc/diagnostics) | CPU, heap, goroutine, mutex/block, scheduler, syscall, GC, and trace evidence in Go's pprof/trace formats. | Profiling modes perturb one another and sampled CPU profiles miss waiting/I/O causality; a Go runtime profile cannot generalize to arbitrary callers or input growth. |
| [Valgrind Callgrind/Cachegrind/Massif](https://valgrind.org/docs/manual/manual.html) | Instrumented call graphs, instruction and call counts, simulated cache/branch behavior, and heap profiles written to files for post-processing. | Instrumentation can substantially change runtime and cache behavior; simulation and dynamic traces are workload-specific and cannot establish worst-case bounds. |
| [LLVM optimization remarks](https://llvm.org/docs/Remarks.html) and [MLIR remarks](https://mlir.llvm.org/docs/Remarks/) | Structured passed/missed/analysis/failure feedback explaining compiler transformations, with YAML/bitstream output and machine-readable metrics. | Remarks describe compiler decisions for a build and target; they do not prove end-to-end speedup, semantic equivalence of source rewrites, or application-level complexity. |
| [PostgreSQL `EXPLAIN`](https://www.postgresql.org/docs/current/using-explain.html) | Query-plan trees, estimated costs/rows, `EXPLAIN ANALYZE` actual timing/rows/loops, buffers, and machine-readable output for plan-aware database analysis. | Planner costs are data/platform-dependent; `EXPLAIN ANALYZE` executes the query and can cause side effects, omits client/network work unless configured, and should not be extrapolated from toy-sized tables. |
| [OpenTelemetry Profiles](https://opentelemetry.io/docs/concepts/signals/profiles/) | A common profile signal for code-level resource samples plus metadata that can be correlated with traces, metrics, and logs. | The current specification is marked Alpha; profiles are observability evidence, not a complexity proof, and adoption/exporter support must be checked before making them a required dependency. |
| [AProVE](https://aprove.informatik.rwth-aachen.de/index.php/usage) | Research tooling for termination and complexity proofs that returns explicit lower/upper bounds or unknown/timeout outcomes for supported models. | Proof coverage, cost model, and analysis time are bounded; a failed proof is unknown, not evidence of low cost. It is not a general mixed-language repository analyzer. |
| [COSTA](https://costa.fdi.ucm.es/) | Research tooling for cost/termination analysis that derives cost relations and bounds for supported Java-like/logic-language models and multiple resources. | Prototype language and cost-model coverage is limited; relation solving and unsupported primitives can yield unknown results. |

## Language coverage map

The tools operate at different language boundaries. “Supports a language” can
mean parsing its source, running a language-specific benchmark, profiling its
runtime, or accepting its compiled binary; these are not interchangeable.

| Layer | Tools | Primary language coverage | Important boundary |
| --- | --- | --- | --- |
| Source parsing and structural rules | Python `ast`, Tree-sitter, Semgrep, CodeQL, Lizard | Python; JavaScript/TypeScript; Go; Java/Kotlin; C/C++; C#; Rust; Ruby; PHP; Swift; and other grammars/rule packs | Grammar or query coverage is not semantic type information and does not prove runtime bounds. |
| Formal resource analysis | AProVE, COSTA, AARA-family research tools | Restricted models including Java, C, Haskell, Prolog, rewrite systems, and typed intermediate languages | Unsupported language constructs and external calls become unknown; results depend on the cost model. |
| Language-native benchmarking | pyperf, pytest-benchmark, ASV | Python | Measures declared Python workloads; it does not discover representative inputs or prove equivalence. |
|  | Google Benchmark | C++ | C++ fixture and compiler behavior remain part of the result. |
|  | Criterion.rs | Rust | Rust benchmark statistics remain scoped to the measured workload. |
|  | JMH | Java and other JVM languages | JVM, JIT, GC, fork, and warmup configuration must be retained. |
| Runtime profiling | Scalene | Python | Python/native attribution is sampled and platform-dependent. |
|  | Go `pprof` and `go tool trace` | Go | Runtime profiles expose Go behavior; sampling and profiling modes can perturb one another. |
|  | async-profiler | Java/JVM | JVM-specific profiling, with native/kernel frames when available. |
| Native binary and hardware evidence | Linux `perf`, Valgrind, LIKWID | Language-agnostic after compilation: C/C++, Rust, Go, Fortran, and other native binaries | Symbols, permissions, counters, instrumentation overhead, and hardware affect evidence quality. |
| Compiler and accelerator backends | LLVM/MLIR, Tiramisu | C/C++ frontends and compiler IR; CUDA, MPI, and data-parallel kernels depending on backend | Compiler remarks and generated-code benchmarks describe a target build, not general application complexity. |
| System/database evidence | PostgreSQL `EXPLAIN`, OpenTelemetry Profiles | SQL/database plans; any application language emitting supported telemetry | The application language is secondary to query plans, runtime boundaries, and exported profile metadata. |

The current package is deliberately smaller than this ecosystem: it uses
scanner-owned Python syntax/data-flow facts, Tree-sitter structural coverage,
and TypeScript compiler semantics. The broader table is an adapter catalogue,
not a promise that every tool or language becomes a bundled dependency.

The practical implication is to use a small internal evidence contract and
allow these tools to contribute evidence through adapters. No single external
tool should become the scanner's truth oracle.

## New deductions from the expanded research

### Stress the behavior, not just the size

The common benchmark shortcut is to increase one length parameter and call the
largest fixture “worst case.” WEDGE shows why that is incomplete: a branch
predicate, ordering, duplicate pattern, graph shape, or cache state may control
the expensive path. A useful workload generator should therefore record both
the size vector and the *stress condition* that makes a path expensive. For a
scanner candidate, this means testing reverse-sorted, duplicate-heavy, sparse,
dense, already-cached, cache-cold, and failure/partial-success cases where the
operation's semantics make those distinctions relevant.

### Keep three cost signals instead of choosing one winner

Wall-clock time answers the user-impact question but is noisy and includes
runtime, I/O, scheduling, and environment effects. CPU instruction counts or
other hardware counters can be more stable for a controlled comparison, while
allocation/peak-memory and I/O-call counts explain different bottlenecks. The
research supports retaining these as separate measurements: a stable
instruction-count improvement must not be promoted to a wall-clock claim, and
a wall-clock win must not be labeled an algorithmic complexity change without
theoretical evidence.

### Separate the unit of optimization

Function-level, file-level, and repository-level tasks have different failure
modes. A local edit can pass a function benchmark but regress a caller through
allocation, ordering, cache invalidation, or database behavior. Conversely, a
repository speedup may come from a dependency or configuration change outside
the flagged function. Reports should identify the intended target, the measured
path, and the actual changed path independently.

### Make confidence monotonic and evidence-specific

The newer learned-optimization work reinforces the existing evidence-broker
design. A model-generated strategy, a static candidate, a formal bound, a
behavioral oracle, and a runtime sample are different evidence objects. They
can be joined by location and workload identity, but one must not silently
upgrade another. A recommendation should be downgraded when the workload is
unrepresentative, the target path is not reached, correctness coverage is
partial, or the result is unstable across environments.

### Hybrid analysis is a composition problem, not a confidence average

Recent resource-analysis work makes the static/dynamic division more precise:
static analysis can provide sound bounds on an analyzable fragment, while
data-driven or Bayesian analysis can cover fragments static methods cannot but
does not automatically provide sound worst-case guarantees. The useful future
abstraction is a resource component with a declared interface—such as loop
iterations, recursion depth, allocations, or bytes transferred—rather than a
single confidence score. Composition should preserve provenance and cost
semantics, and a report should show exactly which fragments were proved,
measured, manually modeled, or left unknown.

### Differential optimization oracles can test causality

Passive profiling identifies correlation. Database research adds two stronger
patterns: compare an optimized execution with a semantically equivalent
non-optimizing form for correctness, and selectively disable an optimizer branch
to test whether the alleged optimization changes the measured cost. These
patterns are powerful but require white-box access and safe controls. They
belong in optional system adapters, not in a source-only scanner.

### Treat benchmark infrastructure as a research dependency

ASV, pyperf, pytest-benchmark, and hyperfine cover useful parts of the
measurement problem, but none supplies the whole contract. The project still
needs a repository-specific layer for input families, behavior oracles,
permission/network policy, artifact identity, and cross-machine replay. The
right future CLI should orchestrate these boundaries rather than duplicate
their timing statistics.

### Repository patterns worth borrowing

The GitContribute/GitWiki pass found a few reusable patterns that are more
valuable than copying any one repository's implementation:

| Repository pattern | Transferable design | Boundary to preserve |
| --- | --- | --- |
| [Google Benchmark](https://github.com/google/benchmark), [Criterion.rs](https://github.com/bheisler/criterion.rs), [JMH](https://github.com/openjdk/jmh) | Parameterized workloads, warmup, repeated samples/forks, compiler/JIT safeguards, and structured output. | Framework statistics are scoped to the measured workload and runtime; they do not prove repository correctness or worst-case complexity. |
| [Scalene](https://github.com/plasma-umass/scalene) and [LIKWID](https://github.com/RRZE-HPC/likwid) | Attach CPU, allocation, copy, cache, memory, power, and region-level signals to source or workload identity. | Signals are platform-, privilege-, sampling-, and counter-dependent; unsupported metrics must remain explicit. |
| [Tiramisu](https://github.com/Tiramisu-Compiler/tiramisu) | Treat affine/polyhedral IR and schedule transformations as a specialized backend for locality, tiling, fusion, and parallelism. | Regular static-control programs are a narrow subset; dynamic dispatch, services, databases, and irregular workloads need other evidence. |
| [Lizard](https://github.com/terryyin/lizard) | Keep maintainability/code-shape metrics available as a separate ranking signal. | NLOC, token count, parameter count, and cyclomatic complexity do not establish asymptotic runtime. |
| [PerfForge](https://github.com/cirrus-uchicago/perfforge) | Preserve stress inputs, expected outputs, solution identity, and test provenance as first-class workload artifacts. | A stress corpus is an input/oracle asset, not a general analyzer or a substitute for the repository's own workload. |

The GitContribute corpus also exposed an important operational rule: every
source-backed repository result should carry the selected revision, indexed
file counts, skipped-file counts, and truncation status. Search metadata and
derived GitWiki summaries are discovery aids; they should not be silently
promoted to complete source coverage.

### Match the tool to the runtime boundary

The maintained resources divide into useful but non-interchangeable layers:

```text
source structure       -> AST / Tree-sitter / Semgrep / CodeQL
local CPU or allocation -> Scalene / async-profiler / hardware counters
microbenchmark         -> pyperf / Criterion / Google Benchmark / JMH
process-level command   -> hyperfine / ASV adapters
database execution      -> EXPLAIN / EXPLAIN ANALYZE / buffers / query counts
distributed service     -> traces, metrics, profiles, queue and tail-latency data
```

The boundary matters. A static `find()` call can be a linear scan, but a
database client's apparent call cost may instead be dominated by planner
choices, row estimates, network serialization, connection pooling, or lock
wait. PostgreSQL's own documentation explicitly separates planner cost from
client transmission and warns that `EXPLAIN ANALYZE` has execution and timing
side effects. The scanner should route such findings to a plan/workload
investigation rather than emit a source-only Big-O verdict.

## Redesign options

### A. Evidence broker around multiple analyzers — recommended

Keep the current dependency-light scanner as a fallback, but give every
finding a stable location, signal name, source span, static facts, assumptions,
unknowns, and evidence stage. Add optional adapters for Tree-sitter or
Semgrep-produced structural matches, repository call/test discovery, and
profiling/benchmark artifacts. The report then joins evidence without
pretending that a syntax match is a proof.

This is the best fit for an npm-distributed agent skill: it preserves an
offline first pass, supports repositories that cannot build, and creates a
clear path to stronger evidence when the host has the relevant toolchain.

### B. Full static complexity analyzer

Lower supported languages into an intermediate representation, infer loops,
recurrences, collection abstractions, call graphs, and ranking functions, and
emit symbolic bounds. This is the strongest theoretical direction, but it is a
multi-year language-semantics project. It would also produce many “unknown”
results for dynamic dispatch, reflection, native calls, databases, and
framework behavior. It should be an optional proof backend, not the first
rewrite of the skill.

### C. Execution-first performance assistant

Start from repository test commands or user-provided workloads, profile them,
attribute cost to functions, and use static scanning only to explain the hot
path. This is likely to produce more practically useful recommendations, but
it needs safe workload discovery, dependency setup, representative inputs,
permissions, isolation, and a policy for network/database access.

### D. Learned ranking or optimization recommender

Train a model on optimization pairs and repository tasks to rank candidates or
suggest edits. [PIE](https://huggingface.co/papers/2302.07867) and the
[problem-oriented/anchor-verification work](https://huggingface.co/papers/2406.11935)
show how correctness and execution feedback can be part of the data loop, but
the model remains a heuristic. It should rank evidence-backed candidates after
static and runtime gates, never replace those gates.

## Recommended report contract

Every candidate should be able to carry the following fields, whether or not a
field is populated:

```text
location: path + source span
language: parser and language confidence
pattern: nested-iteration | membership | sort | recursion | I/O | render | allocation | other
static_facts: syntax and local data-flow observations
unknowns: unresolved types, bounds, callers, framework behavior, or workload coverage
estimated_bound: optional symbolic or reviewer-derived estimate, never inferred solely from a label
assumptions: input-size, collection, ordering, mutability, and environment assumptions
evidence_stage: syntax | inferred | theoretical | measured | behavioral | practical
workload: command, fixture, input family, and revision if measured
measurement: raw samples, repetitions, summary, noise/stability, machine, and tool versions
behavior: baseline/candidate equivalence checks and their coverage
recommendation: an optimization family plus semantic risks, not an automatic edit
```

The most important rule is monotonic evidence: a later runtime measurement can
upgrade a candidate, but a static signal must never silently inherit the
confidence of a benchmark or a formal proof.

## Research sequence

1. Define and test the report contract against the existing labeled corpus and
   add adversarial labels for comments, strings, aliases, known collection
   types, comprehensions, recursion, and nested callbacks.
2. Measure repository-context discovery separately: callers, tests, benchmark
   commands, input constructors, and side-effect boundaries. A scanner finding
   should be useful even when no workload is available.
3. Build one benchmark adapter first, preferably a generic subprocess protocol
   with explicit setup, workload, correctness oracle, and teardown. Use
   `pyperf`, `pytest-benchmark`, or a repository-native harness behind the
   adapter rather than reimplementing their statistics.
4. Add empirical scaling experiments for synthetic examples. Fit only a small
   declared family of curves, retain raw data and residuals, and label the
   result as observed scaling rather than a proof of worst-case complexity.
5. Prototype formal bound analysis on a deliberately restricted subset such as
   affine integer loops. Keep “proved,” “estimated,” “measured,” and “unknown”
   as distinct outcomes.
6. Only after those gates exist, evaluate learned ranking or automated edits on
   repository-level tasks with hidden behavior checks and workload variation.

The research recommendation is therefore a redesign toward an evidence broker,
with a dependency-free static fallback, optional parser/rule adapters, and
explicit workload and behavior evidence. A full static theorem prover and an
automatic optimizer are downstream experiments, not the next default feature.
