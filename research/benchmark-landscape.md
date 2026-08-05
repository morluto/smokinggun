# Benchmark and workload-corpus landscape

This file separates benchmark resources from benchmark harnesses. A harness
controls measurement; a workload corpus determines what behavior is exercised.
Using a reliable harness on an unrepresentative workload still produces a
misleading optimization claim.

## Corpus families

| Family | Representative resources | What it is good for | What it cannot establish alone |
| --- | --- | --- | --- |
| Empirical complexity and code-generation tasks | [BigO(Bench)](https://huggingface.co/papers/2503.15242), [COFFE](https://huggingface.co/papers/2502.02827), [PerfForge](https://github.com/cirrus-uchicago/perfforge) | Controlled input growth, stressful cases, function/file efficiency, and comparisons of optimization systems. | Repository side effects, production traffic, permissions, databases, and arbitrary language/runtime behavior. |
| Learned compiler and affine-loop workloads | [LOOPerSet](https://huggingface.co/papers/2510.10209), [PolyBench/C](https://www.cs.colostate.edu/~pouchet/software/polybench/) | Loop fusion, tiling, skewing, vectorization, locality, and parallel scheduling on regular kernels. | Dynamic dispatch, irregular graphs, external systems, application semantics, and transfer to services. |
| Python and language-runtime suites | [pyperformance](https://github.com/python/pyperformance), [Renaissance](https://renaissance.dev/) | Interpreter/compiler/JIT/GC changes, real language workloads, warmup behavior, and runtime regressions. | A hotspot's repository path, application-specific correctness, or general algorithmic bounds. |
| Database and decision-support workloads | [TPC current specifications](https://tpc.org/TPC_Documents_Current_Versions/current_specifications5.asp), including TPC-H and TPC-DS | Query planning, indexing, joins, aggregation, storage, throughput, and scale-factor behavior under published rules. | A product's schema/query mix, transaction semantics, authorization, network behavior, or app-level N+1 patterns. |
| ML training/inference/system suites | [MLPerf Inference](https://docs.mlcommons.org/inference/submission/), [MLPerf Training](https://mlcommons.org/benchmarks/training/) | Hardware/software stack, throughput/latency, quality-constrained training, accelerator scaling, and system bottlenecks. | General-purpose code optimization, non-ML workloads, or portability outside the submitted scenario/hardware rules. |
| Repository-level optimization tasks | [SWE-Perf](https://huggingface.co/papers/2507.12415), [GSO](https://huggingface.co/papers/2505.23671), [SWE-fficiency](https://huggingface.co/papers/2511.06090), [FormulaCode](https://huggingface.co/papers/2603.16011), [ISO-Bench](https://huggingface.co/papers/2602.19594), [PERFOPT-Bench](https://huggingface.co/papers/2607.07744) | Caller/context discovery, executable repository workloads, target localization, correctness gates, and expert-relative speedups. | Stable universal rankings; benchmark validity, machine effects, workload coverage, and aggregation rules still need auditing. |

## How to select a corpus

1. **Match the corpus to the claim.** Use affine kernels for locality or loop
   transformations, query workloads for plan/index claims, runtime suites for
   JIT/GC/compiler claims, and repository workloads for end-to-end changes.
2. **Preserve the workload identity.** Record corpus name, revision/digest,
   license, generator version, scale factor, seed, input distribution, and
   expected output/oracle. “TPC-H-like” or “random data” is not enough for
   replay.
3. **Vary the dimensions that change semantics.** For example, database scale
   factor is not a substitute for selectivity, skew, concurrency, or result
   cardinality; a graph's node count is not a substitute for density or
   topology; a model's parameter count is not a substitute for sequence length,
   batch size, or quality target.
4. **Separate correctness from cost.** A benchmark's reference output, a
   baseline implementation, a differential oracle, and a timing signal are
   different artifacts. A faster result with wrong output is a failed
   candidate, not a speedup.
5. **Keep per-workload results.** Report the distribution, regressions, and
   workload coverage before computing an aggregate. Harmonic or robust
   aggregation can summarize a declared score, but it cannot conceal a failed
   workload.
6. **Audit environmental coupling.** Retain compiler/runtime flags, CPU/GPU,
   memory, storage, network, container/image, driver, database statistics,
   JVM/GC configuration, and warmup policy. Mark claims as environment-bound
   when replay across environments is unavailable.

## Stress dimensions by domain

| Domain | Minimum stress matrix |
| --- | --- |
| Collections and algorithms | Empty/singleton, duplicates, hit/miss ratio, sorted/reverse/random order, sparse/dense matches, independent input dimensions, and memory pressure. |
| Graphs | Sparse/dense, disconnected, cyclic, skewed degree, weighted/negative-edge restrictions, repeated queries, and topology-preserving size growth. |
| Text | Alphabet/Unicode normalization, repetitive/adversarial strings, pattern count/length, overlap, locale, and regex backtracking risk. |
| Database | Scale factor, selectivity, skew, cardinality, indexes/statistics, joins, pagination/limits, concurrency, cache state, plan choice, and network serialization. |
| Services | Request mix, concurrency, queue depth, payload size, cache state, retries/timeouts, partial failure, downstream latency, and tail percentiles. |
| JVM/interpreted runtimes | Warmup/JIT state, GC/heap, allocation rate, forks/process isolation, input parameters, and steady-state versus startup cost. |
| GPU/parallel | Batch size, worker/device count, transfer size, synchronization, occupancy, skew, deterministic output, and failure/cancellation behavior. |

## Implication for this project

The package currently has a static candidate scanner but no workload corpus or
benchmark adapter. The first useful evaluation corpus should therefore be
small and inspectable:

- synthetic fixtures for each local finding with independent dimensions and
  adversarial distributions;
- a behavior oracle that compares baseline and candidate outputs and side
  effects; and
- at least one repository-level task with a real caller and executable workload.

External suites should be adapters or reference sources, not bundled as a
universal score. The scanner can suggest which corpus family is appropriate,
but it cannot infer that choice from a loop pattern alone.

## Repository-backed corpus lessons

The GitContribute/GitWiki repository pass adds a concrete corpus rule. PerfForge
is not just a set of large inputs: its public layout pairs full tests with
expected outputs, solution-specific slow tests, and metadata describing the
source solution and measured ranking. The canonical repository is now
`cirrus-uchicago/perfforge` (the previously cited `UChiSeclab` identity
redirects there). Its public README describes 207 problems and approximately
51 GiB of data, which makes it a reference or sampled external corpus rather
than a sensible package dependency.

Tiramisu and LIKWID illustrate the opposite kind of corpus. Tiramisu's
benchmarks and tests exercise generated code for regular data-parallel
programs; LIKWID's tests and marker examples exercise platform-specific
counter and region measurements. Both are valuable for specialized adapters,
but their workload and hardware assumptions must be carried into the report.
Lizard's indexed tests are useful for validating static metric extraction, not
for validating runtime-complexity claims. These distinctions belong in corpus
metadata and evaluation reports, not only in prose documentation.
