import {expect, it} from "vitest";
import {buildScalingComparison} from "./compare.js";
import type {ScalingAnalysisV1} from "../protocol/index.js";

it("compares scaling points deterministically", () => {
  const base = scaling("base", [10, 20]);
  const candidate = scaling("candidate", [8, 21]);
  const result = buildScalingComparison(base, candidate, "baseline.json", "candidate.json");
  expect(result.mode).toBe("scaling");
  expect(result.points?.map((point) => point.improvement)).toEqual([true, false]);
  expect(result.improvement).toBe(false);
  expect(result.promotion).toBe("inconclusive");
  expect(result.promotionReasons).toContain("configured-statistical-policy-not-met");
});

function scaling(id: string, medians: ReadonlyArray<number>): ScalingAnalysisV1 {
  return {
    schemaVersion: "footgun.scaling.v1",
    id: `scale_${id === "base" ? "a".repeat(16) : "b".repeat(16)}`,
    workloadDigest: "a".repeat(64),
    parameter: "items",
    points: medians.map((medianMs, index) => ({value: index + 1, status: "complete", samplesMs: [medianMs], medianMs, meanMs: medianMs, quartiles: {q1Ms: medianMs, q3Ms: medianMs}, statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0}, timedOut: false, behaviorValidated: true})),
    models: [],
    environment: {node: "22", platform: "test", arch: "test"},
    limitations: [],
  };
}
