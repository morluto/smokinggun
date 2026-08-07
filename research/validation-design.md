# Validation and evaluation design

The package has automated unit, property, corpus, CLI, adapter, lifecycle, and
packed-artifact checks. The design below records the evidence required before
a finding becomes an optimization candidate, and before a candidate becomes an
accepted patch.

## 1. Installer and package contract

Run these checks against the packed tarball, not only the checkout:

| Area | Required check |
| --- | --- |
| Contents | `npm pack --dry-run --json`; assert the allowlisted files, modes, digests, and no accidental credentials/caches |
| Version | The manifest version equals the release tag; after publish, `npm view` returns that version and the recorded integrity digest |
| Fresh install | Empty temporary project; the shared Skills CLI discovers `skills/footgun/SKILL.md`, and npm installation exposes the `footgun` scanner |
| Repeat install | Installing twice is deterministic and leaves the same file hashes |
| Custom files | A pre-existing marker and user-added file are tested explicitly; the chosen overwrite/backup contract is asserted |
| Failure | Missing bundled `SKILL.md` or an unavailable CLI produces a visible recovery path without silently claiming success |
| Permissions | The installed scanner and installer retain executable behavior where required; read-only or permission-denied destinations are covered |

The shared Skills CLI owns skill placement, conflict handling, and updates.
Footgun only ships the self-contained skill document; npm installation does not
write agent directories or install anything implicitly.

## 2. Scanner precision and recall

Maintain a labeled corpus with positive and negative examples for each supported
finding kind, language, and syntax form. Labels describe an actionable pattern,
not merely the presence of a keyword. Include:

- empty files and empty repositories;
- one loop versus nested loops with independent dimensions;
- list, tuple, set, dictionary, string, and unknown membership collections;
- aliases, method calls, callbacks, comprehensions, generator expressions, and
  loops in nested function definitions;
- sorting once outside a loop versus sorting on each iteration;
- local helper names that resemble query APIs and actual database/API calls;
- comments, string literals, multiline expressions, and malformed source;
- recursion, graph traversal, and bounded loops as explicit unsupported or
  candidate-only labels;
- likely render paths with small and large transforms.

For each pattern, report a confusion matrix, precision, recall, and the exact
corpus revision. Do not aggregate a positive finding from one language with a
negative finding from another. The committed corpus is a small regression gate,
not a language-wide coverage claim; expand it before making broader accuracy
claims.

## 3. Behavioral equivalence matrix

Every proposed optimization gets a baseline/candidate pair and a behavior
oracle. The oracle must exercise observable semantics before performance is
measured:

| Risk dimension | Cases to include |
| --- | --- |
| Inputs | empty input, singleton, large input, null/missing values, malformed values |
| Duplicates | duplicate keys, duplicate records, repeated requests, repeated references |
| Ordering | stable output order, tie behavior, first/last/all match behavior, pagination order |
| Mutation | input mutation, object identity, aliasing, cache mutation, iterator consumption |
| Errors | exception type/message where contractual, partial failure, retry, timeout, cancellation |
| Permissions | tenant boundaries, authorization filters, soft deletes, forbidden/missing records |
| Pagination | page boundaries, cursor/token progression, empty pages, short final page |
| Caching | cache hit/miss, invalidation, stale data, key normalization, concurrent refresh |
| I/O and rendering | request count, query count, side effects, render count, resource cleanup |

Use property-based or parameterized tests when the domain supports them, plus
focused regression examples for the reported hotspot. A test that only checks a
single happy-path output is not sufficient to accept a map/set conversion,
batching, memoization, or query rewrite.

## 4. Empirical scaling protocol

For an asymptotic claim, declare the input dimensions and generate inputs whose
semantics remain valid as size grows. For example, a nested lookup uses
`n = len(left)` and `m = len(right)` and measures a grid of `(n, m)` rather than
only `n = m`.

Protocol:

1. Run correctness checks on every generated input.
2. Warm up the process and discard warmup measurements.
3. Measure baseline and candidate in a randomized or alternating order to
   reduce temporal drift.
4. Record at least 10 repetitions per size for a local microbenchmark, raw
   samples, CPU/memory limits, interpreter/compiler version, machine, and input
   seed. Increase repetitions when variance is high.
5. Report median and a robust interval (for example bootstrap or quantiles),
   speedup distribution, and failure/time-out counts.
6. Fit only declared candidate curves; show residuals and the input range. A
   fitted O(n) curve over a narrow range does not prove asymptotic O(n).
7. Run representative repository workloads separately from synthetic scaling.
   A constant-factor win, I/O reduction, or cache effect must be labeled as
   such rather than converted into a Big-O claim.

### 4.1 Stress conditions and multiple cost signals

Do not equate the largest input with the most informative input. For each
candidate, record the dimensions being scaled and the condition expected to
make the path expensive: reverse-sorted order, duplicate density, sparse or
dense matches, graph topology, cache hit/miss state, pagination boundary, or
failure/partial-success behavior. WEDGE's performance-constraint approach is a
useful model for generating such cases from path predicates; the generated
case must still be checked against the repository's behavior oracle.

Retain separate measurements for:

- end-to-end wall time, which represents user impact but includes scheduling,
  I/O, runtime, and hardware noise;
- a stable supplemental cost signal such as CPU instructions, allocations,
  peak memory, query/request count, or bytes moved; and
- the actual target path and workload coverage, so a fast benchmark on an
  unrelated path cannot upgrade the finding.

COFFE's instruction-count metric is evidence that a lower-noise signal can make
controlled comparisons easier, not evidence that instruction counts replace
wall time or external-system measurements. A report should therefore be able
to say “instruction count improved, end-to-end time inconclusive” without
collapsing the two claims.

### 4.2 Claim-specific evidence

Use the evidence required by the declared complexity model:

| Claim | Minimum evidence beyond a syntax finding |
| --- | --- |
| Worst-case or multivariate bound | Named input dimensions, data-structure assumptions, adversarial or boundary cases, and a proof or clearly labeled reviewer derivation. |
| Expected/randomized cost | Input distribution, random seed policy, collision/variance behavior, and repeated samples across the distribution. |
| Amortized cost | A sequence workload, state/potential assumptions, and both aggregate and per-operation latency. |
| Output-sensitive cost | Output cardinality as an input dimension, duplicate/order cases, and early-termination behavior. |
| External-memory/cache cost | Cache/storage state, bytes or blocks moved, allocation/I/O counters, and end-to-end time. |
| Parallel/GPU cost | Work, synchronization/transfer measurements, target hardware, determinism checks, and scaling with worker count. |
| Database/system bottleneck | Query plan or trace, row/cardinality facts, wait/I/O/network measurements, concurrency level, and production-like workload. |
| Structural maintainability | A declared structural metric and review/test impact; never present it as a runtime or memory bound. |

Missing evidence lowers the claim to `candidate` or `unverified`; it does not
justify filling the field with an assumed Big-O class.

### 4.3 Workload-corpus identity

Every measured claim must identify the workload corpus separately from the
benchmark harness. Record the corpus revision or digest, generator version,
license, scale factor, seed, input distribution, expected output/oracle, and
the reason the corpus matches the declared claim. A reliable harness cannot
repair an unrepresentative workload.

Use external suites as domain adapters: affine kernels for locality and loop
transforms, language-runtime suites for JIT/GC/compiler work, TPC-style suites
for database planning, MLPerf-style suites for accelerator systems, and
repository tasks for caller/context and end-to-end behavior. Keep per-workload
results and regressions before computing any aggregate.

The scanner's own startup and parsing cost is a useful baseline. On this host,
five-run medians for one Python file were approximately 44.0 ms at 100 lines,
47.8 ms at 1,000, 102.2 ms at 10,000, and 665.5 ms at 100,000. These numbers
are an environment-specific smoke measurement, not a product SLA; they are
consistent with a mostly linear scan after fixed process/AST overhead.

## 5. Noise and cross-machine replay

For any claim that matters beyond a local developer workflow, repeat the same
packed source, workload, seed, and configuration on at least two machine
profiles. Capture:

- machine/OS/kernel, CPU model, core count, memory, container/image digest;
- interpreter/compiler and dependency lock information;
- warmup policy, repetition count, timeout, and process isolation;
- raw baseline/candidate timings and resource samples;
- correctness result per repetition and workload;
- the statistical test or acceptance threshold used.

If a result changes direction or loses statistical support across machines,
report it as machine-specific or inconclusive. Do not average away a failure.
The supplied benchmark literature shows why this matters: cross-machine replay
can invalidate reference patches, and scoring rules can make a small number of
unstable tasks dominate an aggregate.

## 6. Optimization acceptance gate

An optimization is accepted only when all of the following are true:

1. The static finding is tied to a real symbol and workload path, or the report
   explicitly says that context is unresolved.
2. Baseline behavior passes the full relevant oracle and the candidate passes
   the same oracle, including the matrix above.
3. The measured improvement is on the intended target path, positive under the
   declared workload, and is not
   explained only by a warmup, cache, timeout, or benchmark-order artifact.
4. The stress condition, input dimensions, raw samples, and supplemental cost
   signals are recorded; missing signals are marked unavailable rather than
   inferred.
5. The claimed complexity change follows from stated assumptions and is
   consistent with the scaling measurements; otherwise report only a constant
   factor or practical bottleneck.
6. The patch is reviewed for authorization, tenant/permission filtering,
   ordering, pagination, errors, mutation, and invalidation semantics.
7. The final report records the exact commands, raw/summary measurements,
   environment, proof gaps, and residual risks.

Failure at any gate leaves the recommendation as `unverified` or `blocked`; it
does not become an automatic edit merely because the scanner ranked it highly.
