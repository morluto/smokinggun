import {describe, expect, it} from "vitest";
import {importBenchmark} from "./benchmarks.js";

describe("standard benchmark importers", () => {
  it("normalizes Hyperfine seconds and preserves raw artifact identity", () => {
    const result = importBenchmark(
      {results: [{command: "node fixture.js", times: [0.001, 0.003, 0.002]}]},
      {tool: "hyperfine", rawArtifact: "benchmarks/hyperfine.json"},
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.records[0]).toMatchObject({
      name: "node fixture.js",
      sourceUnit: "s",
      medianMs: 2,
      rawArtifact: "benchmarks/hyperfine.json",
    });
    expect(result.records[0]?.samplesMs).toEqual([1, 3, 2]);
  });

  it("normalizes Google Benchmark units and rejects malformed input", () => {
    const result = importBenchmark(
      {benchmarks: [{name: "BM_lookup", real_time: 2_000, time_unit: "ns"}]},
      {tool: "google-benchmark"},
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.records[0]?.medianMs).toBe(0.002);
    const unsupportedUnit = importBenchmark(
      {benchmarks: [{name: "BM_lookup", real_time: 2_000, time_unit: "cycles"}]},
      {tool: "google-benchmark"},
    );
    expect("code" in unsupportedUnit && unsupportedUnit.code).toBe("unsupported-google-benchmark-time-unit");
    const invalid = importBenchmark({benchmarks: []}, {tool: "jmh"});
    expect("code" in invalid && invalid.code).toBe("invalid-jmh");
  });

  it("groups Google Benchmark repetitions and excludes aggregate summaries from samples", () => {
    const result = importBenchmark(
      {
        benchmarks: [
          {name: "BM_X", run_name: "BM_X", real_time: 10, time_unit: "ms", run_type: "iteration"},
          {name: "BM_X", run_name: "BM_X", real_time: 20, time_unit: "ms", run_type: "iteration"},
          {
            name: "BM_X_mean",
            run_name: "BM_X",
            real_time: 15,
            time_unit: "ms",
            run_type: "aggregate",
            aggregate_name: "mean",
          },
          {
            name: "BM_X_stddev",
            run_name: "BM_X",
            real_time: 5,
            time_unit: "ms",
            run_type: "aggregate",
            aggregate_name: "stddev",
          },
        ],
      },
      {tool: "google-benchmark"},
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      name: "BM_X",
      samplesMs: [10, 20],
      medianMs: 15,
      meanMs: 15,
      metadata: {
        runType: "iteration",
        repetitions: 2,
        aggregateCount: 2,
        aggregateNames: "mean,stddev",
      },
    });
  });

  it("rejects Google Benchmark aggregate rows without raw iterations", () => {
    const result = importBenchmark(
      {
        benchmarks: [
          {
            name: "BM_X_mean",
            run_name: "BM_X",
            real_time: 15,
            time_unit: "ms",
            run_type: "aggregate",
            aggregate_name: "mean",
          },
        ],
      },
      {tool: "google-benchmark"},
    );
    expect(result).toMatchObject({code: "invalid-google-benchmark"});
  });

  it("preserves distinct Criterion summary estimates", () => {
    const result = importBenchmark(
      {
        mean: {point_estimate: 2_000_000},
        median: {point_estimate: 1_000_000},
      },
      {tool: "criterion"},
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.records[0]).toMatchObject({
      samplesMs: [2],
      medianMs: 1,
      meanMs: 2,
      metadata: {summaryOnly: true},
    });
  });

  it("converts JMH throughput to milliseconds per operation", () => {
    const result = importBenchmark(
      [
        {
          benchmark: "Example.run",
          mode: "thrpt",
          primaryMetric: {score: 1000, scoreUnit: "ops/s"},
        },
      ],
      {tool: "jmh"},
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.records[0]).toMatchObject({samplesMs: [1], medianMs: 1, sourceUnit: "ops/s"});
    const unsupportedUnit = importBenchmark(
      [{benchmark: "Example.run", mode: "avgt", primaryMetric: {score: 1, scoreUnit: "cycles"}}],
      {tool: "jmh"},
    );
    expect("code" in unsupportedUnit && unsupportedUnit.code).toBe("unsupported-jmh-time-unit");
  });
});
