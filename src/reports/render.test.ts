import {describe, expect, it} from "vitest";
import type {ScanReportV2} from "../protocol/index.js";
import {parseReportArtifact, renderScanReport, toSarif} from "./render.js";

const report: ScanReportV2 = {
  schemaVersion: "smokinggun.scan-report.v2",
  tool: {name: "smokinggun", version: "2.0.0"},
  repository: {root: ".", revision: null, dirty: false},
  configDigest: "a".repeat(64),
  findings: [],
  coverage: [
    {
      scanner: "smokinggun.structural",
      version: "1.0.0",
      language: "mixed",
      filesDiscovered: 0,
      filesAnalyzed: 0,
      parseStatus: "complete",
      skippedFiles: [],
    },
  ],
  diagnostics: [],
  timings: {startedAt: "2026-08-05T00:00:00.000Z", durationMs: 1},
  assumptions: ["static only"],
  rawArtifacts: [],
};

describe("report renderers", () => {
  it("round-trips JSON and emits valid SARIF", () => {
    const parsed = parseReportArtifact(JSON.parse(renderScanReport(report, "json")) as unknown);
    expect("_tag" in parsed).toBe(false);
    expect(toSarif(report)).toMatchObject({
      version: "2.1.0",
      runs: [{tool: {driver: {name: "smokinggun", version: "2.0.0"}}, results: []}],
    });
  });

  it("keeps assumptions visible in human output", () => {
    expect(renderScanReport(report, "human")).toContain("static only");
  });

  it("reports a completed scan invocation as successful when diagnostics are present", () => {
    const sarif = toSarif({
      ...report,
      diagnostics: [
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "findings-truncated",
          message: "Finding output was truncated.",
          recovery: "Increase the finding limit.",
        },
      ],
    });

    expect(sarif).toMatchObject({runs: [{invocations: [{executionSuccessful: true}]}]});
  });

  it("reports unavailable scan coverage as an unsuccessful invocation", () => {
    const sarif = toSarif({
      ...report,
      coverage: [
        {
          ...report.coverage[0],
          parseStatus: "unavailable",
          reason: "The scanner could not run.",
        },
      ],
    });

    expect(sarif).toMatchObject({runs: [{invocations: [{executionSuccessful: false}]}]});
  });

  it("reports empty scan coverage as an unsuccessful invocation", () => {
    const sarif = toSarif({...report, coverage: []});

    expect(sarif).toMatchObject({runs: [{invocations: [{executionSuccessful: false}]}]});
  });
});
