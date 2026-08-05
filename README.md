# Footgun

Footgun is a local, offline-by-default complexity scanner and evidence tool for Codex. It combines structural rules, pinned Tree-sitter WASM parse coverage, and a TypeScript compiler-backed context index without executing repository source or applying source edits during static scans.

## Install

```bash
npm install -g footgun
footgun skill install
```

The explicit skill installer writes `$CODEX_HOME/skills/complexity-optimizer` and refuses to replace an existing directory unless `--force` is supplied. Installation never runs from npm lifecycle hooks.

## Use

```bash
footgun scan .
footgun scan . --format json
footgun scan . --format sarif --output footgun.sarif
footgun scan . --fail-on medium
footgun scanners list
footgun investigate .
footgun context import index.scip
footgun doctor --probe-isolation
```

Findings are candidates with assumptions, provenance, related evidence, and explicit coverage. Static scans do not fail because findings exist unless `--fail-on` matches a severity, rule ID, or the special value `finding`. Measurement is a separate, opt-in workflow and requires both a workload descriptor and `--execute`; a comparison is promotable only when declared behavior checks pass for both artifacts.

Workloads inherit only a small non-secret environment allowlist by default. Use `inheritEnvironment: true` only when the workload explicitly requires it. Supported behavior checks include `exit-code:<n>`, `stdout-sha256:<digest>`, and `stderr-sha256:<digest>`.

Workloads default to the `median-improvement` statistical policy with no minimum relative gain. Set `statisticalPolicy.kind` to `non-overlapping-iqr` when a comparison must show separated interquartile ranges; the policy and quartiles are retained in every measurement and scaling point.

Workloads may declare `inputSizeParameterization` with a `name`, numeric `values`, and an explicit zero-based `commandIndex`. `footgun measure` substitutes only those command arguments, runs every point, and emits a `footgun.scaling.v1` artifact containing all observations and candidate constant, logarithmic, linear, linearithmic, and quadratic fits. It never invokes a shell. Standard Hyperfine, pyperf, Google Benchmark, Criterion, and JMH JSON can be normalized through the exported `importBenchmark` adapter while preserving the source tool and artifact reference.

`doctor --probe-isolation` reports whether Docker, Podman, bwrap, or nsjail are discoverable. The local runner refuses unsupported profiles and records any isolation downgrade; it does not silently claim container or filesystem-read-only enforcement.

`footgun report artifact.json --benchmark hyperfine|pyperf|google-benchmark|criterion|jmh` imports standard benchmark JSON. `footgun report profile.pb.gz --profile pprof` decodes gzip-compressed pprof profiles through the maintained `pprof-format` binding. `footgun report trace-summary.json --profile perfetto` accepts bounded JSON rows emitted by a Perfetto trace-processor query. Raw `.pftrace` files can be queried with an explicitly installed `trace_processor` binary: `FOOTGUN_TRACE_PROCESSOR=/path/to/trace_processor footgun report trace.pftrace --profile perfetto --trace-query 'SELECT ts, dur, name FROM slice LIMIT 1000'`. CSV output is bounded to 1,000 rows and 2 MB; a missing processor is reported as an unavailable capability.

`typescript` is a runtime dependency because semantic indexing is performed locally through the TypeScript compiler API. Grammar sources, revisions, generated WASM digests, and ABI compatibility are recorded in [`grammar.lock.json`](grammar.lock.json); the package ships the pinned grammar assets.

Footgun 1.0 does not provide automatic code rewriting, telemetry, an MCP server, a Python runtime dependency, or implicit network access.
