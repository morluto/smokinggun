import {describe, expect, it} from "vitest";
import {parseScanReport, Protocol} from "./index.js";

describe("protocol contracts", () => {
  it("rejects unknown fields in a scan report", () => {
    const result = Protocol.scanReport.safeParse({schemaVersion: "footgun.scan-report.v2", extra: true});
    expect(result.success).toBe(false);
  });

  it("returns a typed problem for an unsupported artifact", () => {
    const result = parseScanReport({schemaVersion: "footgun.scan-report.v2"});
    expect("_tag" in result).toBe(true);
    if ("_tag" in result) expect(result.code).toBe("invalid-scan-report");
  });

  it("parses each workload execution mode as a distinct legal shape", () => {
    const common = {
      schemaVersion: "footgun.workload.v2",
      command: ["node", "script.js", "0", "0"],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 1_000,
      requestedProfile: "local-exec",
      expectedArtifacts: [],
      behaviorChecks: [],
    };

    expect(Protocol.workload.safeParse(common).success).toBe(true);
    expect(
      Protocol.workload.safeParse({
        ...common,
        inputSizeParameterization: {name: "items", values: [1], commandIndex: 2},
      }).success,
    ).toBe(true);
    expect(
      Protocol.workload.safeParse({
        ...common,
        multiParameterization: {
          parameters: [
            {name: "paths", values: [1], commandIndex: 2},
            {name: "terms", values: [1], commandIndex: 3},
          ],
          maxPoints: 1,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects incompatible or internally inconsistent workload plans at the boundary", () => {
    const common = {
      schemaVersion: "footgun.workload.v2",
      command: ["node", "script.js", "0"],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 1_000,
      requestedProfile: "local-exec",
      expectedArtifacts: [],
      behaviorChecks: [],
    };
    const inputSizeParameterization = {name: "items", values: [1], commandIndex: 2};
    const multiParameterization = {
      parameters: [
        {name: "paths", values: [1, 2], commandIndex: 2},
        {name: "paths", values: [1], commandIndex: 2},
      ],
      coordinates: [{paths: 1}],
      maxPoints: 1,
    };

    expect(Protocol.workload.safeParse({...common, inputSizeParameterization, multiParameterization}).success).toBe(
      false,
    );
    expect(
      Protocol.workload.safeParse({
        ...common,
        inputSizeParameterization: {...inputSizeParameterization, commandIndex: 3},
      }).success,
    ).toBe(false);
    expect(Protocol.workload.safeParse({...common, multiParameterization}).success).toBe(false);
  });

  it("rejects scaling points whose duplicate state fields disagree", () => {
    const point = {
      value: 1,
      status: "timed-out",
      samplesMs: [],
      medianMs: 0,
      meanMs: 0,
      quartiles: {q1Ms: 0, q3Ms: 0},
      statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
      timedOut: true,
      behaviorValidated: false,
    };

    expect(Protocol.scalingPoint.safeParse(point).success).toBe(true);
    expect(Protocol.scalingPoint.safeParse({...point, timedOut: false}).success).toBe(false);
    expect(Protocol.scalingPoint.safeParse({...point, status: "complete"}).success).toBe(false);
  });

  it("rejects adapter artifact digests that are detached from declared artifacts", () => {
    const result = {
      schemaVersion: "footgun.adapter-result.v2",
      requestId: "request",
      state: "complete",
      findings: [],
      coverage: [],
      diagnostics: [],
      rawArtifacts: [],
      rawArtifactDigests: {"result.json": "0".repeat(64)},
    };

    expect(Protocol.adapterResult.safeParse(result).success).toBe(false);
    expect(Protocol.adapterResult.safeParse({...result, rawArtifacts: ["result.json"]}).success).toBe(true);
  });

  it("rejects evidence digests detached from artifacts within scan findings", () => {
    const result = Protocol.scanReport.safeParse({
      schemaVersion: "footgun.scan-report.v2",
      tool: {name: "smokinggun", version: "1.0.0"},
      repository: {root: ".", revision: null, dirty: false},
      configDigest: "0".repeat(64),
      findings: [
        {
          schemaVersion: "footgun.finding.v2",
          id: "fg_0123456789abcdef",
          scanner: "fixture",
          scannerVersion: "1.0.0",
          ruleId: "fixture-rule",
          severity: "info",
          confidence: "verified",
          message: "fixture",
          suggestion: "fixture",
          location: {path: "fixture.ts", startLine: 1, startColumn: 0, endLine: 1, endColumn: 1},
          assumptions: [],
          evidence: [],
          evidenceRecords: [
            {
              schemaVersion: "footgun.evidence.v2",
              id: "fixture-evidence",
              kind: "static",
              summary: "fixture",
              digest: "0".repeat(64),
            },
          ],
          complexity: {},
        },
      ],
      coverage: [],
      diagnostics: [],
      timings: {startedAt: "2026-01-01T00:00:00.000Z", durationMs: 0},
      assumptions: [],
      rawArtifacts: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects benchmark provenance digests without their artifact", () => {
    const record = {
      schemaVersion: "footgun.benchmark-record.v2",
      id: "bench_0123456789abcdef",
      tool: "hyperfine",
      name: "fixture",
      samplesMs: [1],
      medianMs: 1,
      meanMs: 1,
      sourceUnit: "ms",
      metadata: {},
    };
    const result = {
      schemaVersion: "footgun.benchmark-import.v2",
      tool: "hyperfine",
      records: [record],
      rawArtifactDigest: "0".repeat(64),
    };

    expect(Protocol.benchmarkImport.safeParse(result).success).toBe(false);
    expect(Protocol.benchmarkImport.safeParse({...result, rawArtifact: "fixture.json"}).success).toBe(true);
  });

  it("keeps measurement and scaling comparison payloads disjoint", () => {
    const common = {
      schemaVersion: "footgun.comparison.v2",
      id: "cmp_0123456789abcdef",
      baseline: "baseline.json",
      candidate: "candidate.json",
      workloadDigest: "0".repeat(64),
      behaviorValidated: true,
      improvement: true,
      statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
    };
    const measurement = {
      ...common,
      mode: "measurement",
      baselineMedianMs: 10,
      candidateMedianMs: 5,
      deltaPercent: -50,
    };

    expect(Protocol.comparison.safeParse(measurement).success).toBe(true);
    expect(Protocol.comparison.safeParse({...measurement, baselineDigest: "0".repeat(64)}).success).toBe(false);
    expect(
      Protocol.comparison.safeParse({
        ...measurement,
        baselineDigest: "0".repeat(64),
        candidateDigest: "1".repeat(64),
      }).success,
    ).toBe(true);
    expect(Protocol.comparison.safeParse({...measurement, points: []}).success).toBe(false);
    expect(
      Protocol.comparison.safeParse({
        ...common,
        mode: "scaling",
        points: [
          {
            value: 1,
            baselineMedianMs: 10,
            candidateMedianMs: 5,
            deltaPercent: -50,
            improvement: true,
            statisticalPolicy: common.statisticalPolicy,
          },
        ],
      }).success,
    ).toBe(true);
  });
});
