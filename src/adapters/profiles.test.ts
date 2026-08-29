import {gzipSync} from "node:zlib";
import {expect, it} from "vitest";
import {Function as PprofFunction, Location, Profile, Sample, StringTable, ValueType} from "pprof-format";
import {importPerfettoSummary, importPerfettoTrace, importPprof} from "./profiles.js";

it("decodes a gzip-compressed pprof profile through the maintained binding", () => {
  const strings = new StringTable();
  const type = strings.dedup("samples");
  const unit = strings.dedup("count");
  const name = strings.dedup("work");
  const profile = new Profile({
    stringTable: strings,
    sampleType: [new ValueType({type, unit})],
    function: [new PprofFunction({id: 1, name, systemName: name, filename: strings.dedup("fixture.ts"), startLine: 1})],
    location: [new Location({id: 1, line: [{functionId: 1, line: 1, column: 1}]})],
    sample: [new Sample({locationId: [1], value: [3]})],
  });
  const result = importPprof(gzipSync(profile.encode()), {sourceArtifact: "profile.pb.gz"});
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.sampleCount).toBe(1);
  expect(result.topFunctions[0]).toMatchObject({name: "work", value: 3, unit: "count"});
});

it("rejects pprof numeric values that cannot be represented exactly", () => {
  const strings = new StringTable();
  const type = strings.dedup("bytes");
  const unit = strings.dedup("bytes");
  const name = strings.dedup("allocate");
  const profile = new Profile({
    stringTable: strings,
    sampleType: [new ValueType({type, unit})],
    function: [new PprofFunction({id: 1, name, systemName: name, filename: strings.dedup("fixture.ts"), startLine: 1})],
    location: [new Location({id: 1, line: [{functionId: 1, line: 1, column: 1}]})],
    sample: [new Sample({locationId: [1], value: [BigInt(Number.MAX_SAFE_INTEGER) + 1n]})],
  });

  const result = importPprof(gzipSync(profile.encode()), {sourceArtifact: "profile.pb.gz"});

  expect(result).toMatchObject({code: "pprof-numeric-value-out-of-range"});
});

it("rejects pprof gzip output above the configured decompressed size limit", () => {
  const result = importPprof(gzipSync(Buffer.alloc(256)), {
    sourceArtifact: "oversized.pb.gz",
    maxDecompressedBytes: 64,
  });
  expect("code" in result && result.code).toBe("pprof-decompressed-output-too-large");
});

it("normalizes bounded Perfetto trace-processor rows", () => {
  const result = importPerfettoSummary(
    {columns: ["name", "duration"], rows: [{name: "main", duration: 12.5}]},
    {sourceArtifact: "trace.pftrace"},
  );
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.columns).toEqual(["name", "duration"]);
  expect(result.rows[0]?.duration).toBe(12.5);
});

it("rejects a Perfetto summary whose declared columns omit a row field", () => {
  const result = importPerfettoSummary(
    {columns: ["name"], rows: [{name: "main", duration: 12.5}]},
    {sourceArtifact: "trace.pftrace"},
  );
  expect("code" in result && result.code).toBe("invalid-perfetto-summary");
});

it("imports raw Perfetto traces through an explicitly supplied trace processor", async () => {
  const result = await importPerfettoTrace({
    sourceArtifact: "trace.pftrace",
    sourceDigest: "a".repeat(64),
    tracePath: "trace.pftrace",
    query: "SELECT name, dur FROM slice LIMIT 1",
    executable: process.execPath,
    executableArgs: ["-e", "process.stdout.write('name,dur\\nmain,12.5\\n')"],
  });
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.query).toContain("SELECT name");
  expect(result.rows[0]).toMatchObject({name: "main", dur: 12.5});
});

it("accepts one terminated Perfetto statement and semicolons inside SQL strings", async () => {
  for (const query of ["SELECT name FROM slice;", "SELECT ';' AS separator;"]) {
    const result = await importPerfettoTrace({
      sourceArtifact: "trace.pftrace",
      sourceDigest: "a".repeat(64),
      tracePath: "trace.pftrace",
      query,
      executable: process.execPath,
      executableArgs: ["-e", "process.stdout.write('name\\nmain\\n')"],
    });
    expect("code" in result).toBe(false);
  }
});

it("rejects multiple Perfetto statements", async () => {
  const result = await importPerfettoTrace({
    sourceArtifact: "trace.pftrace",
    sourceDigest: "a".repeat(64),
    tracePath: "trace.pftrace",
    query: "SELECT 1; SELECT 2",
    executable: process.execPath,
  });
  expect(result).toMatchObject({code: "invalid-perfetto-query"});
});
