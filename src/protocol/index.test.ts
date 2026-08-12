import {createHash} from "node:crypto";
import {describe, expect, it} from "vitest";
import {parseScanReport, Protocol} from "./index.js";
import {canonicalJson} from "./canonical-json.js";

describe("protocol contracts", () => {
  it("rejects unknown fields in a scan report", () => {
    const result = Protocol.scanReport.safeParse({schemaVersion: "smokinggun.scan-report.v2", extra: true});
    expect(result.success).toBe(false);
  });

  it("rejects self-referential or duplicated finding identities", () => {
    const finding = {
      schemaVersion: "smokinggun.finding.v2",
      id: "sg_0123456789abcdef",
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
      complexity: {},
    };
    expect(Protocol.finding.safeParse(finding).success).toBe(true);
    expect(Protocol.finding.safeParse({...finding, location: {...finding.location, path: "."}}).success).toBe(false);
    expect(Protocol.finding.safeParse({...finding, location: {...finding.location, path: "/fixture.ts"}}).success).toBe(
      false,
    );
    expect(
      Protocol.finding.safeParse({...finding, location: {...finding.location, path: "../fixture.ts"}}).success,
    ).toBe(false);
    expect(
      Protocol.finding.safeParse({...finding, location: {...finding.location, path: "src\\fixture.ts"}}).success,
    ).toBe(false);
    expect(Protocol.finding.safeParse({...finding, relatedFindings: [finding.id]}).success).toBe(false);
    expect(
      Protocol.finding.safeParse({...finding, relatedFindings: ["sg_1111111111111111", "sg_1111111111111111"]}).success,
    ).toBe(false);
  });

  it("rejects an evidence artifact reference with no identity", () => {
    const evidence = {
      schemaVersion: "smokinggun.evidence.v2",
      id: "fixture:scan",
      kind: "static",
      claimClass: "static-fact",
      summary: "Fixture scan",
      artifact: "scan-report.json",
    };
    expect(Protocol.evidence.safeParse(evidence).success).toBe(true);
    expect(Protocol.evidence.safeParse({...evidence, artifact: ""}).success).toBe(false);
  });

  it("allows diagnostics to identify the repository root without allowing root locations", () => {
    const problem = {
      schemaVersion: "smokinggun.problem.v1",
      code: "fixture",
      message: "Fixture diagnostic",
      path: ".",
      recovery: "Fix the fixture.",
    };
    expect(Protocol.problem.safeParse(problem).success).toBe(true);
  });

  it("requires report finding relations to resolve within that report", () => {
    const finding = {
      schemaVersion: "smokinggun.finding.v2",
      id: "sg_0123456789abcdef",
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
      complexity: {},
    };
    const report = {
      schemaVersion: "smokinggun.scan-report.v2",
      tool: {name: "smokinggun", version: "1.0.0"},
      repository: {root: ".", revision: null, dirty: false},
      configDigest: "a".repeat(64),
      findings: [finding],
      coverage: [],
      diagnostics: [],
      timings: {startedAt: "2026-01-01T00:00:00.000Z", durationMs: 0},
      assumptions: [],
      rawArtifacts: [],
    };
    expect(Protocol.scanReport.safeParse(report).success).toBe(true);
    expect(
      Protocol.scanReport.safeParse({...report, findings: [{...finding, relatedFindings: ["sg_aaaaaaaaaaaaaaaa"]}]})
        .success,
    ).toBe(false);
    expect(Protocol.scanReport.safeParse({...report, filesModified: ["fixture.ts"]}).success).toBe(false);
    const coverage = {
      scanner: "fixture",
      version: "1.0.0",
      language: "typescript",
      filesDiscovered: 0,
      filesAnalyzed: 0,
      parseStatus: "complete",
      skippedFiles: [],
    };
    expect(Protocol.scanReport.safeParse({...report, coverage: [coverage, coverage]}).success).toBe(false);
    const inventory = {
      schemaVersion: "smokinggun.repository-inventory.v1",
      languages: [],
      manifests: ["package.json"],
      packageManagers: ["pnpm"],
      tests: [],
      benchmarks: [],
      generated: [],
      ignored: [],
      digest: "a".repeat(64),
    };
    expect(Protocol.scanReport.safeParse({...report, inventory}).success).toBe(true);
    expect(
      Protocol.scanReport.safeParse({...report, inventory: {...inventory, manifests: ["package.json", "package.json"]}})
        .success,
    ).toBe(false);
  });

  it("returns a typed problem for an unsupported artifact", () => {
    const result = parseScanReport({schemaVersion: "smokinggun.scan-report.v2"});
    expect("_tag" in result).toBe(true);
    if ("_tag" in result) expect(result.code).toBe("invalid-scan-report");
  });

  it("rejects repeated adapter declaration and request capabilities", () => {
    const manifest = {
      schemaVersion: "smokinggun.adapter-manifest.v1",
      id: "fixture",
      version: "1.0.0",
      command: ["fixture"],
      languages: ["typescript"],
      capabilities: ["scan"],
      limits: {timeoutMs: 1, maxOutputBytes: 1, maxArtifactBytes: 1},
    };
    expect(Protocol.adapterManifest.safeParse(manifest).success).toBe(true);
    expect(Protocol.adapterManifest.safeParse({...manifest, capabilities: ["scan", "scan"]}).success).toBe(false);
    const request = {
      schemaVersion: "smokinggun.adapter-request.v1",
      requestId: "fixture",
      root: ".",
      config: {},
      targets: ["fixture.ts"],
      requestedCapabilities: ["scan"],
    };
    expect(Protocol.adapterRequest.safeParse(request).success).toBe(true);
    expect(Protocol.adapterRequest.safeParse({...request, targets: ["fixture.ts", "fixture.ts"]}).success).toBe(false);
  });

  it("rejects impossible coverage counts and duplicate skipped paths", () => {
    const coverage = {
      scanner: "fixture",
      version: "1.0.0",
      language: "typescript",
      filesDiscovered: 2,
      filesAnalyzed: 1,
      parseStatus: "partial",
      skippedFiles: ["src/missing.ts"],
      reason: "The fixture scanner skipped a source file.",
    };
    expect(Protocol.coverage.safeParse(coverage).success).toBe(true);
    expect(Protocol.coverage.safeParse({...coverage, reason: undefined}).success).toBe(false);
    expect(Protocol.coverage.safeParse({...coverage, filesAnalyzed: 3}).success).toBe(false);
    expect(Protocol.coverage.safeParse({...coverage, parseStatus: "complete"}).success).toBe(false);
    expect(
      Protocol.coverage.safeParse({
        ...coverage,
        filesAnalyzed: 2,
        parseStatus: "complete",
        skippedFiles: ["src/missing.ts"],
      }).success,
    ).toBe(false);
    expect(Protocol.coverage.safeParse({...coverage, skippedFiles: ["src/missing.ts", "src/missing.ts"]}).success).toBe(
      false,
    );
  });

  it("requires explained incomplete compiler context coverage", () => {
    const index = {
      schemaVersion: "smokinggun.context-index.v1",
      tool: {name: "typescript", version: "1.0.0"},
      files: [],
      definitions: [],
      references: [],
      calls: [],
      coverage: {
        filesDiscovered: 1,
        filesIndexed: 0,
        parseStatus: "partial",
        skippedFiles: [],
        reason: "Fixture failed.",
      },
      revision: null,
      stale: false,
      digest: "a".repeat(64),
    };
    expect(Protocol.contextIndex.safeParse(index).success).toBe(true);
    expect(Protocol.contextIndex.safeParse({...index, coverage: {...index.coverage, reason: undefined}}).success).toBe(
      false,
    );
    expect(
      Protocol.contextIndex.safeParse({
        ...index,
        coverage: {filesDiscovered: 1, filesIndexed: 0, parseStatus: "complete", skippedFiles: []},
      }).success,
    ).toBe(false);
    expect(
      Protocol.contextIndex.safeParse({
        ...index,
        coverage: {...index.coverage, filesIndexed: 1},
      }).success,
    ).toBe(false);
    expect(
      Protocol.contextIndex.safeParse({
        ...index,
        definitions: [{name: "fixture", kind: "function", path: "fixture.ts", line: 1, column: 0}],
      }).success,
    ).toBe(false);
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

  it("binds multi-scaling coordinates to their declared parameters and digest", () => {
    const coordinates = [{paths: 1, terms: 2}];
    const point = {
      value: 0,
      coordinates: coordinates[0],
      status: "complete",
      samplesMs: [1],
      medianMs: 1,
      meanMs: 1,
      quartiles: {q1Ms: 1, q3Ms: 1},
      statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
      timedOut: false,
      behaviorValidated: true,
    };
    const result = {
      schemaVersion: "smokinggun.scaling.v3",
      id: `scale_${"a".repeat(16)}`,
      benchmarkDigest: "b".repeat(64),
      parameters: ["paths", "terms"],
      coordinatesDigest: createHash("sha256").update(canonicalJson(coordinates)).digest("hex"),
      points: [point],
      reproduction: {
        command: ["node"],
        cwd: ".",
        environmentKeys: [],
        timeoutMs: 1,
        warmups: 0,
        repetitions: 1,
        expectedArtifacts: [],
      },
      environment: {node: "22", platform: "test", arch: "test"},
      limitations: [],
    };
    expect(Protocol.multiScaling.safeParse(result).success).toBe(true);
    expect(Protocol.multiScaling.safeParse({...result, coordinatesDigest: "c".repeat(64)}).success).toBe(false);
    expect(
      Protocol.multiScaling.safeParse({...result, points: [{...point, coordinates: {paths: 1, extra: 2}}]}).success,
    ).toBe(false);
    const duplicateCoordinates = [point, {...point, value: 1}];
    expect(
      Protocol.multiScaling.safeParse({
        ...result,
        points: duplicateCoordinates,
        coordinatesDigest: createHash("sha256")
          .update(canonicalJson(duplicateCoordinates.map((value) => value.coordinates)))
          .digest("hex"),
      }).success,
    ).toBe(false);
  });

  it("binds a selected scaling model to unique measured points and model definitions", () => {
    const point = {
      value: 1,
      status: "complete",
      samplesMs: [1],
      medianMs: 1,
      meanMs: 1,
      quartiles: {q1Ms: 1, q3Ms: 1},
      statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
      timedOut: false,
      behaviorValidated: true,
    };
    const model = {name: "linear" as const, coefficients: [0, 1], residual: 0, rSquared: 1};
    const analysis = {
      schemaVersion: "smokinggun.scaling.v2",
      id: `scale_${"a".repeat(16)}`,
      benchmarkDigest: "b".repeat(64),
      parameter: "items",
      points: [point],
      models: [model],
      selectedModel: "linear" as const,
      reproduction: {
        command: ["node"],
        cwd: ".",
        environmentKeys: [],
        timeoutMs: 1,
        warmups: 0,
        repetitions: 1,
        expectedArtifacts: [],
      },
      environment: {node: "22", platform: "test", arch: "test"},
      limitations: [],
    };
    expect(Protocol.scaling.safeParse(analysis).success).toBe(true);
    expect(Protocol.scaling.safeParse({...analysis, selectedModel: "quadratic"}).success).toBe(false);
    expect(Protocol.scaling.safeParse({...analysis, models: [model, model]}).success).toBe(false);
    expect(Protocol.scaling.safeParse({...analysis, points: [point, {...point}]}).success).toBe(false);
    expect(Protocol.scaling.safeParse({...analysis, points: [{...point, samplesMs: [1, 1]}]}).success).toBe(false);
    expect(Protocol.scaling.safeParse({...analysis, points: [{...point, behaviorValidated: false}]}).success).toBe(
      false,
    );
  });

  it("binds trace summary row fields to unique declared columns", () => {
    const summary = {
      schemaVersion: "smokinggun.trace-summary.v1",
      id: `trace_${"b".repeat(16)}`,
      tool: "perfetto",
      sourceArtifact: "trace.pftrace",
      sourceDigest: "b".repeat(64),
      columns: ["name", "duration"],
      rows: [{name: "main", duration: 12.5}],
      limitations: [],
    };
    expect(Protocol.traceSummary.safeParse(summary).success).toBe(true);
    expect(Protocol.traceSummary.safeParse({...summary, columns: ["name"]}).success).toBe(false);
    expect(Protocol.traceSummary.safeParse({...summary, columns: ["name", "name"]}).success).toBe(false);
    expect(Protocol.traceSummary.safeParse({...summary, id: `trace_${"a".repeat(16)}`}).success).toBe(false);
  });

  it("requires evidence for evidence-bearing investigation states", () => {
    const bundle = {
      schemaVersion: "smokinggun.investigation-bundle.v2",
      id: `inv_${"a".repeat(16)}`,
      state: "scanned" as const,
      root: ".",
      createdAt: "2026-01-01T00:00:00.000Z",
      reports: ["scan-report.json"],
      evidence: [
        {
          schemaVersion: "smokinggun.evidence.v2",
          id: "inv_aaaaaaaaaaaaaaaa:scan",
          kind: "static",
          claimClass: "static-fact",
          summary: "Scan",
          artifact: "scan-report.json",
        },
      ],
      diagnostics: [],
    };
    expect(Protocol.investigation.safeParse(bundle).success).toBe(true);
    expect(Protocol.investigation.safeParse({...bundle, evidence: []}).success).toBe(false);
    expect(
      Protocol.investigation.safeParse({
        ...bundle,
        evidence: [{...bundle.evidence[0], artifact: "unrelated-report.json"}],
      }).success,
    ).toBe(false);
    expect(Protocol.investigation.safeParse({...bundle, reports: []}).success).toBe(false);
    expect(
      Protocol.investigation.safeParse({...bundle, reports: ["scan-report.json", "scan-report.json"]}).success,
    ).toBe(false);
    expect(
      Protocol.investigation.safeParse({...bundle, findingIds: ["sg_0123456789abcdef", "sg_0123456789abcdef"]}).success,
    ).toBe(false);
    expect(
      Protocol.investigation.safeParse({...bundle, state: "baseline-measured", reports: ["measurement.json"]}).success,
    ).toBe(false);
    expect(
      Protocol.investigation.safeParse({
        ...bundle,
        state: "behavior-validated",
        reports: ["comparison.json"],
      }).success,
    ).toBe(false);
    expect(
      Protocol.investigation.safeParse({...bundle, state: "context-resolved", reports: ["scan-report.json"]}).success,
    ).toBe(false);
  });

  it("requires passing behavior evidence before a measurement can claim validation", () => {
    const measurement = {
      schemaVersion: "smokinggun.measurement.v1",
      id: `meas_${"a".repeat(16)}`,
      benchmarkDigest: "b".repeat(64),
      samplesMs: [1],
      warmups: 0,
      repetitions: 1,
      medianMs: 1,
      meanMs: 1,
      quartiles: {q1Ms: 1, q3Ms: 1},
      statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
      reproduction: {
        command: ["node"],
        cwd: ".",
        environmentKeys: [],
        timeoutMs: 1,
        warmups: 0,
        repetitions: 1,
        expectedArtifacts: [],
      },
      behaviorValidated: true,
      executionProfile: "local-exec",
      environment: {node: "22", platform: "test", arch: "test"},
      isolation: {backend: "host-process", controlsRequested: [], controlsApplied: [], downgradeReasons: []},
    };
    expect(Protocol.measurement.safeParse(measurement).success).toBe(false);
    expect(
      Protocol.measurement.safeParse({...measurement, behaviorChecks: [{check: "exit-code:0", passed: true}]}).success,
    ).toBe(true);
    expect(
      Protocol.measurement.safeParse({...measurement, behaviorChecks: [{check: "exit-code:0", passed: false}]}).success,
    ).toBe(false);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        behaviorChecks: [{check: "exit-code:0", passed: true}],
        isolation: {
          ...measurement.isolation,
          runtime: {name: "repository-benchmark", version: "1.0.0", digest: "c".repeat(64)},
        },
      }).success,
    ).toBe(true);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        behaviorChecks: [{check: "exit-code:0", passed: true}],
        isolation: {...measurement.isolation, undeclaredAuthority: true},
      }).success,
    ).toBe(false);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        behaviorChecks: [{check: "exit-code:0", passed: true}],
        artifact: "",
      }).success,
    ).toBe(false);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        behaviorChecks: [{check: "exit-code:0", passed: true}],
        isolation: {...measurement.isolation, controlsApplied: ["no-shell", "no-shell"]},
      }).success,
    ).toBe(false);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        repetitions: 2,
        behaviorChecks: [{check: "exit-code:0", passed: true}],
      }).success,
    ).toBe(false);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        medianMs: 2,
        behaviorChecks: [{check: "exit-code:0", passed: true}],
      }).success,
    ).toBe(false);
    expect(
      Protocol.measurement.safeParse({
        ...measurement,
        reproduction: {...measurement.reproduction, repetitions: 2},
        behaviorChecks: [{check: "exit-code:0", passed: true}],
      }).success,
    ).toBe(false);
  });

  it("rejects adapter artifact digests that are detached from declared artifacts", () => {
    const result = {
      schemaVersion: "smokinggun.adapter-result.v3",
      requestId: "request",
      state: "complete",
      findings: [],
      coverage: [],
      diagnostics: [],
      rawArtifacts: [],
      rawArtifactDigests: {"result.json": "0".repeat(64)},
    };

    expect(Protocol.adapterResult.safeParse(result).success).toBe(false);
    expect(
      Protocol.adapterResult.safeParse({
        ...result,
        rawArtifacts: ["result.json"],
        rawArtifactContents: {"result.json": "e30="},
      }).success,
    ).toBe(true);
    expect(Protocol.adapterResult.safeParse({...result, rawArtifacts: ["result.json", "result.json"]}).success).toBe(
      false,
    );
    expect(Protocol.adapterResult.safeParse({...result, rawArtifacts: [""]}).success).toBe(false);
    expect(Protocol.adapterResult.safeParse({...result, rawArtifacts: ["../result.json"]}).success).toBe(false);
    const validResult = {...result, rawArtifacts: ["result.json"]};
    expect(Protocol.adapterResult.safeParse({...validResult, state: "failed"}).success).toBe(false);
    expect(Protocol.adapterResult.safeParse({...validResult, state: "partial"}).success).toBe(false);
    expect(
      Protocol.adapterResult.safeParse({
        ...validResult,
        state: "complete",
        coverage: [
          {
            scanner: "fixture",
            version: "1.0.0",
            language: "typescript",
            filesDiscovered: 1,
            filesAnalyzed: 0,
            parseStatus: "partial",
            skippedFiles: ["fixture.ts"],
            reason: "Fixture did not finish.",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      Protocol.adapterResult.safeParse({
        ...validResult,
        state: "complete",
        coverage: [
          {
            scanner: "fixture",
            version: "1.0.0",
            language: "typescript",
            filesDiscovered: 1,
            filesAnalyzed: 1,
            parseStatus: "complete",
            skippedFiles: [],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      Protocol.adapterResult.safeParse({
        ...validResult,
        coverage: [
          {
            scanner: "fixture",
            version: "1.0.0",
            language: "typescript",
            filesDiscovered: 1,
            filesAnalyzed: 0,
            parseStatus: "complete",
            skippedFiles: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts artifact-free AdapterResultV2 while requiring V3 for inline artifacts", () => {
    const result = {
      schemaVersion: "smokinggun.adapter-result.v2",
      requestId: "request",
      state: "complete",
      findings: [],
      coverage: [],
      diagnostics: [],
      rawArtifacts: [],
      rawArtifactDigests: {},
    };
    expect(Protocol.adapterResultV2.safeParse(result).success).toBe(true);
    expect(
      Protocol.adapterResultV2.safeParse({
        ...result,
        rawArtifacts: ["result.json"],
        rawArtifactDigests: {"result.json": "0".repeat(64)},
      }).success,
    ).toBe(false);
  });

  it("rejects evidence digests detached from artifacts within scan findings", () => {
    const result = Protocol.scanReport.safeParse({
      schemaVersion: "smokinggun.scan-report.v2",
      tool: {name: "smokinggun", version: "1.0.0"},
      repository: {root: ".", revision: null, dirty: false},
      configDigest: "0".repeat(64),
      findings: [
        {
          schemaVersion: "smokinggun.finding.v2",
          id: "sg_0123456789abcdef",
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
              schemaVersion: "smokinggun.evidence.v2",
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
      schemaVersion: "smokinggun.benchmark-record.v2",
      id: "bench_0123456789abcdef",
      tool: "hyperfine",
      name: "fixture",
      samplesMs: [1],
      medianMs: 1,
      meanMs: 1,
      sourceUnit: "ms",
      rawArtifact: "fixture.json",
      rawArtifactDigest: "0".repeat(64),
      metadata: {},
    };
    const result = {
      schemaVersion: "smokinggun.benchmark-import.v2",
      tool: "hyperfine",
      records: [record],
      rawArtifactDigest: "0".repeat(64),
    };

    expect(Protocol.benchmarkImport.safeParse(result).success).toBe(false);
    expect(Protocol.benchmarkImport.safeParse({...result, rawArtifact: "fixture.json"}).success).toBe(true);
    expect(Protocol.benchmarkImport.safeParse({...result, rawArtifact: ""}).success).toBe(false);
    expect(
      Protocol.benchmarkImport.safeParse({
        ...result,
        rawArtifact: "fixture.json",
        records: [{...record, meanMs: 2}],
      }).success,
    ).toBe(false);
    expect(
      Protocol.benchmarkImport.safeParse({
        ...result,
        rawArtifact: "fixture.json",
        records: [{...record, medianMs: 0.5, metadata: {summaryOnly: true}}],
      }).success,
    ).toBe(true);
    expect(
      Protocol.benchmarkImport.safeParse({
        ...result,
        rawArtifact: "fixture.json",
        records: [{...record, tool: "jmh"}],
      }).success,
    ).toBe(false);
    expect(
      Protocol.benchmarkImport.safeParse({
        ...result,
        rawArtifact: "fixture.json",
        records: [{...record, rawArtifact: "other.json"}],
      }).success,
    ).toBe(false);
  });

  it("keeps measurement and scaling comparison payloads disjoint", () => {
    const common = {
      schemaVersion: "smokinggun.comparison.v2",
      id: "cmp_0123456789abcdef",
      baseline: "baseline.json",
      candidate: "candidate.json",
      benchmarkDigest: "0".repeat(64),
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
    expect(Protocol.comparison.safeParse({...measurement, deltaPercent: 0}).success).toBe(false);
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
    expect(
      Protocol.comparison.safeParse({
        ...measurement,
        comparability: {status: "comparable", reasons: []},
        promotion: "eligible",
        promotionReasons: [],
      }).success,
    ).toBe(true);
    expect(
      Protocol.comparison.safeParse({
        ...measurement,
        behaviorValidated: false,
        comparability: {status: "comparable", reasons: []},
        promotion: "eligible",
        promotionReasons: [],
      }).success,
    ).toBe(false);
    expect(
      Protocol.comparison.safeParse({
        ...measurement,
        comparability: {status: "cross-machine", reasons: []},
        promotion: "blocked",
        promotionReasons: ["cross-machine-results-not-comparable"],
      }).success,
    ).toBe(false);
    expect(
      Protocol.comparison.safeParse({
        ...measurement,
        comparability: {status: "cross-machine", reasons: ["Fixture environment differs."]},
        promotion: "blocked",
        promotionReasons: ["cross-machine-results-not-comparable"],
      }).success,
    ).toBe(true);
    expect(Protocol.comparison.safeParse({...measurement, promotionReasons: ["unassessed"]}).success).toBe(false);
  });
});
