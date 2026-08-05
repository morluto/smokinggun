import {createHash} from "node:crypto";
import {z} from "zod";
import {Protocol, type BenchmarkImportV1, type BenchmarkRecordV1, type ProblemV1} from "../protocol/index.js";
import {stableJson} from "../serialization.js";

export type BenchmarkTool = BenchmarkRecordV1["tool"];

export type BenchmarkImportOptions = {
  readonly tool: BenchmarkTool;
  readonly rawArtifact?: string;
  readonly rawArtifactDigest?: string;
};

/** Import one standard benchmark JSON document while preserving whether values are raw observations or summaries. */
export function importBenchmark(input: unknown, options: BenchmarkImportOptions): BenchmarkImportV1 | ProblemV1 {
  const records = options.tool === "hyperfine" ? importHyperfine(input, options)
    : options.tool === "pyperf" ? importPyperf(input, options)
      : options.tool === "google-benchmark" ? importGoogleBenchmark(input, options)
        : options.tool === "criterion" ? importCriterion(input, options)
          : importJmh(input, options);
  if ("code" in records) return records;
  const result = {schemaVersion: "footgun.benchmark-import.v1" as const, tool: options.tool, records, ...(options.rawArtifact === undefined ? {} : {rawArtifact: options.rawArtifact}), ...(options.rawArtifactDigest === undefined ? {} : {rawArtifactDigest: options.rawArtifactDigest})};
  const parsed = Protocol.benchmarkImport.safeParse(result);
  return parsed.success ? parsed.data : problem("invalid-benchmark-import", "The normalized benchmark result did not satisfy its protocol contract.", "Check the source benchmark JSON and importer version.");
}

function importHyperfine(input: unknown, options: BenchmarkImportOptions): BenchmarkRecordV1[] | ProblemV1 {
  const object = objectValue(input);
  const results = arrayValue(object?.results);
  if (results === undefined || results.length === 0) return problem("invalid-hyperfine", "The input is not a Hyperfine JSON result with a non-empty results array.", "Export Hyperfine with --export-json and pass that JSON artifact.");
  const records: BenchmarkRecordV1[] = [];
  for (const [index, value] of results.entries()) {
    const entry = objectValue(value);
    const samples = finiteArray(entry?.times);
    const mean = finiteNumber(entry?.mean);
    if (entry === undefined || typeof entry.command !== "string" || (samples === undefined && mean === undefined)) continue;
    const normalized = samples === undefined ? [mean === undefined ? 0 : mean * 1000] : samples.map((sample) => sample * 1000);
    records.push(makeRecord(options, entry.command, normalized, "s", {index, ...(samples === undefined ? {summaryOnly: true} : {})}));
  }
  return records.length === 0 ? problem("invalid-hyperfine", "No usable Hyperfine benchmark result was found.", "Each result needs a command and times or mean in seconds.") : records;
}

function importPyperf(input: unknown, options: BenchmarkImportOptions): BenchmarkRecordV1[] | ProblemV1 {
  const object = objectValue(input);
  const benchmarks = arrayValue(object?.benchmarks);
  if (benchmarks === undefined || benchmarks.length === 0) return problem("invalid-pyperf", "The input is not a pyperf JSON result with a non-empty benchmarks array.", "Export the benchmark with pyperf JSON output and pass that artifact.");
  const records: BenchmarkRecordV1[] = [];
  for (const [index, value] of benchmarks.entries()) {
    const entry = objectValue(value);
    if (entry === undefined || typeof entry.name !== "string") continue;
    const runs = arrayValue(entry.runs) ?? [];
    const samples = runs.flatMap((run) => finiteArray(objectValue(run)?.values) ?? []).map((sample) => sample * 1000);
    const fallback = finiteNumber(entry.mean);
    const normalized = samples.length > 0 ? samples : fallback === undefined ? [] : [fallback * 1000];
    if (normalized.length > 0) records.push(makeRecord(options, entry.name, normalized, "s", {index, ...(samples.length === 0 ? {summaryOnly: true} : {})}));
  }
  return records.length === 0 ? problem("invalid-pyperf", "No usable pyperf benchmark values were found.", "Each benchmark needs run values or a mean expressed in seconds.") : records;
}

function importGoogleBenchmark(input: unknown, options: BenchmarkImportOptions): BenchmarkRecordV1[] | ProblemV1 {
  const object = objectValue(input);
  const benchmarks = arrayValue(object?.benchmarks);
  if (benchmarks === undefined || benchmarks.length === 0) return problem("invalid-google-benchmark", "The input is not Google Benchmark JSON with a non-empty benchmarks array.", "Export Google Benchmark with --benchmark_format=json.");
  const records: BenchmarkRecordV1[] = [];
  for (const [index, value] of benchmarks.entries()) {
    const entry = objectValue(value);
    const realTime = finiteNumber(entry?.real_time);
    if (entry === undefined || typeof entry.name !== "string" || realTime === undefined || typeof entry.time_unit !== "string") continue;
    const unit = entry.time_unit;
    const samples = (finiteArray(entry.repetitions_data) ?? []).map((sample) => convertToMilliseconds(sample, unit));
    const normalized = samples.length > 0 ? samples : [convertToMilliseconds(realTime, unit)];
    records.push(makeRecord(options, entry.name, normalized, unit, {index, runType: typeof entry.run_type === "string" ? entry.run_type : "unknown", ...(samples.length === 0 ? {summaryOnly: true} : {})}));
  }
  return records.length === 0 ? problem("invalid-google-benchmark", "No usable Google Benchmark records were found.", "Each record needs name, real_time, and time_unit.") : records;
}

function importCriterion(input: unknown, options: BenchmarkImportOptions): BenchmarkRecordV1[] | ProblemV1 {
  const object = objectValue(input);
  const mean = finiteNumber(objectValue(object?.mean)?.point_estimate);
  const median = finiteNumber(objectValue(object?.median)?.point_estimate);
  const observed = mean ?? median;
  if (observed === undefined) return problem("invalid-criterion", "The input is not a Criterion estimates JSON artifact.", "Pass a Criterion estimates.json file containing mean or median point_estimate values.");
  const record = makeRecord(options, "criterion", [observed / 1_000_000], "ns", {summaryOnly: true});
  return [{...record, medianMs: (median ?? observed) / 1_000_000, meanMs: mean === undefined ? observed / 1_000_000 : mean / 1_000_000}];
}

function importJmh(input: unknown, options: BenchmarkImportOptions): BenchmarkRecordV1[] | ProblemV1 {
  const entries = arrayValue(input);
  if (entries === undefined || entries.length === 0) return problem("invalid-jmh", "The input is not a JMH JSON array with benchmark records.", "Export JMH using its JSON result format.");
  const records: BenchmarkRecordV1[] = [];
  for (const [index, value] of entries.entries()) {
    const entry = objectValue(value);
    const metric = objectValue(entry?.primaryMetric);
    if (entry === undefined || typeof entry.benchmark !== "string" || metric === undefined || typeof metric.scoreUnit !== "string") continue;
    const rawData = arrayValue(metric.rawData)?.flatMap((group) => finiteArray(group) ?? []) ?? [];
    const score = finiteNumber(metric.score);
    const unit = metric.scoreUnit;
    const normalized = (rawData.length > 0 ? rawData : score === undefined ? [] : [score]).map((value) => convertToMilliseconds(value, unit));
    if (normalized.length > 0) records.push(makeRecord(options, entry.benchmark, normalized, metric.scoreUnit, {index, mode: typeof entry.mode === "string" ? entry.mode : "unknown", ...(rawData.length === 0 ? {summaryOnly: true} : {})}));
  }
  return records.length === 0 ? problem("invalid-jmh", "No usable JMH primary metrics were found.", "Each record needs benchmark, primaryMetric.scoreUnit, and score or rawData.") : records;
}

function makeRecord(options: BenchmarkImportOptions, name: string, samplesMs: number[], sourceUnit: string, metadata: Record<string, string | number | boolean>): BenchmarkRecordV1 {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const digest = createHash("sha256").update(stableJson({tool: options.tool, name, samplesMs, sourceUnit, rawArtifact: options.rawArtifact, rawArtifactDigest: options.rawArtifactDigest, metadata})).digest("hex");
  return {schemaVersion: "footgun.benchmark-record.v1", id: `bench_${digest.slice(0, 16)}`, tool: options.tool, name, samplesMs: sorted, medianMs, meanMs, sourceUnit, ...(options.rawArtifact === undefined ? {} : {rawArtifact: options.rawArtifact}), ...(options.rawArtifactDigest === undefined ? {} : {rawArtifactDigest: options.rawArtifactDigest}), metadata};
}

function convertToMilliseconds(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === "ns" || normalized === "nanoseconds" || normalized === "ns/op") return value / 1_000_000;
  if (normalized === "us" || normalized === "µs" || normalized === "microseconds" || normalized === "us/op") return value / 1_000;
  if (normalized === "s" || normalized === "seconds" || normalized === "s/op") return value * 1000;
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  const result = z.record(z.string(), z.unknown()).safeParse(value);
  return result.success ? result.data : undefined;
}

function arrayValue(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter((entry): entry is number => finiteNumber(entry) !== undefined);
  return numbers.length === value.length ? numbers : undefined;
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}
