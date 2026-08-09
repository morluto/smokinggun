import {expect, it} from "vitest";
import {buildScalingComparison, classifyComparableMeasurementArtifacts} from "./compare.js";
import type {MeasurementArtifactV1, ScalingAnalysisV2} from "../protocol/index.js";

it("classifies only same-kind artifacts from the same workload", () => {
  const baseline = scaling("base", [10]);
  const candidate = scaling("candidate", [8]);
  expect(classifyComparableMeasurementArtifacts(baseline, candidate)).toMatchObject({kind: "single-scaling"});
  expect(
    classifyComparableMeasurementArtifacts(baseline, {...candidate, workloadDigest: "b".repeat(64)}),
  ).toMatchObject({code: "workload-mismatch"});
  expect(classifyComparableMeasurementArtifacts(baseline, measurement())).toMatchObject({
    code: "measurement-kind-mismatch",
  });
  expect(classifyComparableMeasurementArtifacts(baseline, scaling("candidate", [8, 16]))).toMatchObject({
    code: "scaling-points-mismatch",
  });
  expect(classifyComparableMeasurementArtifacts(baseline, {...candidate, parameter: "requests"})).toMatchObject({
    code: "scaling-points-mismatch",
  });
});

it("matches scaling measurements by declared input value rather than array position", () => {
  const baseline = scaling("base", [10, 20]);
  const candidate = scaling("candidate", [8, 16]);
  candidate.points.reverse();
  const result = buildScalingComparison(baseline, candidate, "baseline.json", "candidate.json", [
    "a".repeat(64),
    "b".repeat(64),
  ]);
  expect(result.points).toMatchObject([
    {value: 1, candidateMedianMs: 8},
    {value: 2, candidateMedianMs: 16},
  ]);
});

it("compares scaling points deterministically", () => {
  const base = scaling("base", [10, 20]);
  const candidate = scaling("candidate", [8, 21]);
  const result = buildScalingComparison(base, candidate, "baseline.json", "candidate.json", [
    "a".repeat(64),
    "b".repeat(64),
  ]);
  expect(result.mode).toBe("scaling");
  expect(result.points?.map((point) => point.improvement)).toEqual([true, false]);
  expect(result.improvement).toBe(false);
  expect(result.promotion).toBe("inconclusive");
  expect(result.promotionReasons).toContain("configured-statistical-policy-not-met");
});

it("does not claim behavior validation when any scaling point lacks it", () => {
  const baseline = scaling("base", [10]);
  const candidate = scaling("candidate", [8]);
  baseline.points[0] = {...baseline.points[0], behaviorValidated: false};
  const result = buildScalingComparison(baseline, candidate, "baseline.json", "candidate.json", [
    "a".repeat(64),
    "b".repeat(64),
  ]);
  expect(result.behaviorValidated).toBe(false);
  expect(result.promotionReasons).toContain("behavior-not-validated");
});

it("uses immutable artifact digests in comparison identity", () => {
  const baseline = scaling("base", [10, 20]);
  const candidate = scaling("candidate", [8, 16]);
  const first = buildScalingComparison(baseline, candidate, "baseline.json", "candidate.json", [
    "b".repeat(64),
    "c".repeat(64),
  ]);
  const replacedCandidate = buildScalingComparison(baseline, candidate, "baseline.json", "candidate.json", [
    "b".repeat(64),
    "d".repeat(64),
  ]);
  expect(first.id).not.toBe(replacedCandidate.id);
});

it("omits both provenance fields when comparison artifacts are unavailable", () => {
  const result = buildScalingComparison(
    scaling("base", [10]),
    scaling("candidate", [8]),
    "baseline.json",
    "candidate.json",
  );
  expect("baselineDigest" in result).toBe(false);
  expect("candidateDigest" in result).toBe(false);
});

it("blocks promotion when recorded Node runtimes differ", () => {
  const baseline = scaling("base", [10, 20]);
  const candidate = {...scaling("candidate", [8, 16]), environment: {node: "20", platform: "test", arch: "test"}};
  const result = buildScalingComparison(baseline, candidate, "baseline.json", "candidate.json", [
    "b".repeat(64),
    "c".repeat(64),
  ]);
  expect(result.comparability).toMatchObject({status: "cross-machine"});
  expect(result.promotion).toBe("blocked");
  expect(result.promotionReasons).toContain("cross-machine-results-not-comparable");
});

it("blocks scaling promotion when a point has an isolation downgrade", () => {
  const base = scaling("base", [10, 20]);
  const candidate = scaling("candidate", [5, 10]);
  base.points[0] = {
    ...base.points[0],
    isolation: {
      backend: "host-process",
      controlsRequested: ["network-denied"],
      controlsApplied: ["network-unrestricted"],
      downgradeReasons: ["host-process execution cannot enforce network denial"],
    },
  };
  const result = buildScalingComparison(base, candidate, "baseline.json", "candidate.json", [
    "a".repeat(64),
    "b".repeat(64),
  ]);
  expect(result.promotion).toBe("blocked");
  expect(result.promotionReasons).toContain(
    "execution-control-downgrade:host-process execution cannot enforce network denial",
  );
});

function scaling(id: string, medians: ReadonlyArray<number>): ScalingAnalysisV2 {
  return {
    schemaVersion: "footgun.scaling.v2",
    id: `scale_${id === "base" ? "a".repeat(16) : "b".repeat(16)}`,
    workloadDigest: "a".repeat(64),
    parameter: "items",
    points: medians.map((medianMs, index) => ({
      value: index + 1,
      status: "complete",
      samplesMs: [medianMs],
      medianMs,
      meanMs: medianMs,
      quartiles: {q1Ms: medianMs, q3Ms: medianMs},
      statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
      timedOut: false,
      behaviorValidated: true,
    })),
    models: [],
    environment: {node: "22", platform: "test", arch: "test"},
    limitations: [],
  };
}

function measurement(): MeasurementArtifactV1 {
  return {
    schemaVersion: "footgun.measurement.v1",
    id: `meas_${"c".repeat(16)}`,
    workloadDigest: "a".repeat(64),
    samplesMs: [1],
    warmups: 0,
    repetitions: 1,
    medianMs: 1,
    meanMs: 1,
    quartiles: {q1Ms: 1, q3Ms: 1},
    statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
    reproduction: {
      command: ["true"],
      cwd: ".",
      environmentKeys: [],
      timeoutMs: 1,
      warmups: 0,
      repetitions: 1,
      expectedArtifacts: [],
    },
    behaviorValidated: true,
    behaviorChecks: [{check: "exit-code:0", passed: true}],
    executionProfile: "local-exec",
    environment: {node: "22", platform: "test", arch: "test"},
    isolation: {backend: "host-process", controlsRequested: [], controlsApplied: [], downgradeReasons: []},
  };
}
