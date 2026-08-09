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
    expect(result.records[0]?.samplesMs).toEqual([1, 2, 3]);
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
