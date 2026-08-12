import {expect, it} from "vitest";
import type {ScanReportV2} from "../protocol/index.js";
import {encodeScanArtifact} from "./scan-artifact.js";

const report: ScanReportV2 = {
  schemaVersion: "smokinggun.scan-report.v2",
  tool: {name: "smokinggun", version: "3.0.0"},
  repository: {root: ".", revision: null, dirty: false},
  sourceDigest: "a".repeat(64),
  configDigest: "b".repeat(64),
  findings: [],
  coverage: [],
  diagnostics: [],
  timings: {startedAt: "2026-08-12T00:00:00.000Z", durationMs: 1},
  assumptions: [],
  filesModified: [],
  rawArtifacts: [],
};

it("canonically binds equivalent report objects to the same exact bytes", () => {
  const reordered = {
    rawArtifacts: report.rawArtifacts,
    filesModified: report.filesModified,
    assumptions: report.assumptions,
    timings: report.timings,
    diagnostics: report.diagnostics,
    coverage: report.coverage,
    findings: report.findings,
    configDigest: report.configDigest,
    sourceDigest: report.sourceDigest,
    repository: report.repository,
    tool: report.tool,
    schemaVersion: report.schemaVersion,
  } satisfies ScanReportV2;

  expect(encodeScanArtifact(reordered)).toEqual(encodeScanArtifact(report));
});
