import {createHash} from "node:crypto";
import {stableJson} from "../serialization.js";
import type {ComparisonV1, MeasurementV1, ScalingAnalysisV1, ScalingAnalysisV2} from "../protocol/index.js";

export function buildMeasurementComparison(
  baseline: MeasurementV1,
  candidate: MeasurementV1,
  baselinePath: string,
  candidatePath: string,
  baselineDigest?: string,
  candidateDigest?: string,
): ComparisonV1 {
  const deltaPercent =
    baseline.medianMs === 0 ? 0 : ((candidate.medianMs - baseline.medianMs) / baseline.medianMs) * 100;
  const improvement = isImprovement(
    baseline.medianMs,
    candidate.medianMs,
    baseline.quartiles,
    candidate.quartiles,
    baseline.statisticalPolicy,
  );
  const reasons = promotionReasons({
    behaviorValidated: baseline.behaviorValidated && candidate.behaviorValidated,
    improvement,
    comparable: environmentsMatch(baseline.environment, candidate.environment),
    downgradeReasons: [...baseline.isolation.downgradeReasons, ...candidate.isolation.downgradeReasons],
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  return {
    schemaVersion: "footgun.comparison.v1",
    id: comparisonIdFor(baselinePath, candidatePath, baseline.workloadDigest, baselineDigest, candidateDigest),
    mode: "measurement",
    baseline: baselinePath,
    candidate: candidatePath,
    workloadDigest: baseline.workloadDigest,
    baselineMedianMs: baseline.medianMs,
    candidateMedianMs: candidate.medianMs,
    deltaPercent,
    improvement,
    behaviorValidated: baseline.behaviorValidated && candidate.behaviorValidated,
    statisticalPolicy: baseline.statisticalPolicy,
    ...(baselineDigest === undefined ? {} : {baselineDigest}),
    ...(candidateDigest === undefined ? {} : {candidateDigest}),
    comparability: comparability(baseline.environment, candidate.environment),
    promotion: promotionStatus(reasons),
    promotionReasons: reasons,
  };
}

export function buildScalingComparison(
  baseline: ScalingAnalysisV1,
  candidate: ScalingAnalysisV1,
  baselinePath: string,
  candidatePath: string,
  baselineDigest?: string,
  candidateDigest?: string,
): ComparisonV1 {
  const points = baseline.points.map((point, index) => {
    const other = candidate.points[index];
    const deltaPercent = point.medianMs === 0 ? 0 : (((other?.medianMs ?? 0) - point.medianMs) / point.medianMs) * 100;
    const policy = point.statisticalPolicy;
    return {
      value: point.value,
      baselineMedianMs: point.medianMs,
      candidateMedianMs: other?.medianMs ?? 0,
      deltaPercent,
      improvement:
        other === undefined
          ? false
          : isImprovement(point.medianMs, other.medianMs, point.quartiles, other.quartiles, policy),
      statisticalPolicy: policy,
    };
  });
  const improvement = points.length > 0 && points.every((point) => point.improvement);
  const reasons = promotionReasons({
    behaviorValidated:
      baseline.points.every((point) => point.behaviorValidated) &&
      candidate.points.every((point) => point.behaviorValidated),
    improvement,
    comparable: environmentsMatch(baseline.environment, candidate.environment),
    downgradeReasons: [...baseline.points, ...candidate.points].flatMap(
      (point) => point.isolation?.downgradeReasons ?? [],
    ),
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  return {
    schemaVersion: "footgun.comparison.v1",
    id: comparisonIdFor(baselinePath, candidatePath, baseline.workloadDigest, baselineDigest, candidateDigest),
    mode: "scaling",
    baseline: baselinePath,
    candidate: candidatePath,
    workloadDigest: baseline.workloadDigest,
    behaviorValidated: true,
    improvement,
    comparability: comparability(baseline.environment, candidate.environment),
    promotion: promotionStatus(reasons),
    promotionReasons: reasons,
    ...(baselineDigest === undefined ? {} : {baselineDigest}),
    ...(candidateDigest === undefined ? {} : {candidateDigest}),
    points,
    ...(baseline.points[0] === undefined ? {} : {statisticalPolicy: baseline.points[0].statisticalPolicy}),
    ...(baseline.selectedModel === undefined ? {} : {baselineModel: baseline.selectedModel}),
    ...(candidate.selectedModel === undefined ? {} : {candidateModel: candidate.selectedModel}),
  };
}

export function buildMultiScalingComparison(
  baseline: ScalingAnalysisV2,
  candidate: ScalingAnalysisV2,
  baselinePath: string,
  candidatePath: string,
  baselineDigest?: string,
  candidateDigest?: string,
): ComparisonV1 {
  const points = baseline.points.map((point, index) => {
    const other = candidate.points[index];
    const deltaPercent = point.medianMs === 0 ? 0 : (((other?.medianMs ?? 0) - point.medianMs) / point.medianMs) * 100;
    return {
      value: point.value,
      coordinates: point.coordinates,
      baselineMedianMs: point.medianMs,
      candidateMedianMs: other?.medianMs ?? 0,
      deltaPercent,
      improvement:
        other !== undefined &&
        isImprovement(point.medianMs, other.medianMs, point.quartiles, other.quartiles, point.statisticalPolicy),
      statisticalPolicy: point.statisticalPolicy,
    };
  });
  const improvement = points.length > 0 && points.every((point) => point.improvement);
  const reasons = promotionReasons({
    behaviorValidated:
      baseline.points.every((point) => point.behaviorValidated) &&
      candidate.points.every((point) => point.behaviorValidated),
    improvement,
    comparable: environmentsMatch(baseline.environment, candidate.environment),
    downgradeReasons: [],
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  return {
    schemaVersion: "footgun.comparison.v1",
    id: comparisonIdFor(baselinePath, candidatePath, baseline.workloadDigest, baselineDigest, candidateDigest),
    mode: "scaling",
    baseline: baselinePath,
    candidate: candidatePath,
    workloadDigest: baseline.workloadDigest,
    behaviorValidated:
      baseline.points.every((point) => point.behaviorValidated) &&
      candidate.points.every((point) => point.behaviorValidated),
    improvement,
    comparability: comparability(baseline.environment, candidate.environment),
    promotion: promotionStatus(reasons),
    promotionReasons: reasons,
    ...(baselineDigest === undefined ? {} : {baselineDigest}),
    ...(candidateDigest === undefined ? {} : {candidateDigest}),
    points,
    ...(baseline.points[0] === undefined ? {} : {statisticalPolicy: baseline.points[0].statisticalPolicy}),
  };
}

type Environment = {readonly node: string; readonly platform: string; readonly arch: string};

function environmentsMatch(left: Environment, right: Environment): boolean {
  return left.platform === right.platform && left.arch === right.arch;
}

function comparability(
  left: Environment,
  right: Environment,
): {readonly status: "comparable" | "cross-machine"; readonly reasons: string[]} {
  if (environmentsMatch(left, right)) return {status: "comparable", reasons: []};
  return {
    status: "cross-machine",
    reasons: [`Environment differs: ${left.platform}/${left.arch} versus ${right.platform}/${right.arch}.`],
  };
}

function promotionReasons(input: {
  readonly behaviorValidated: boolean;
  readonly improvement: boolean;
  readonly comparable: boolean;
  readonly downgradeReasons: ReadonlyArray<string>;
  readonly digestsAvailable: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!input.behaviorValidated) reasons.push("behavior-not-validated");
  if (!input.improvement) reasons.push("configured-statistical-policy-not-met");
  if (!input.comparable) reasons.push("cross-machine-results-not-comparable");
  if (input.downgradeReasons.length > 0)
    reasons.push(...input.downgradeReasons.map((reason) => `execution-control-downgrade:${reason}`));
  if (!input.digestsAvailable) reasons.push("immutable-artifact-digests-missing");
  return reasons;
}

function promotionStatus(reasons: ReadonlyArray<string>): "eligible" | "blocked" | "inconclusive" {
  if (reasons.length === 0) return "eligible";
  if (
    reasons.some(
      (reason) =>
        reason === "behavior-not-validated" ||
        reason === "configured-statistical-policy-not-met" ||
        reason === "immutable-artifact-digests-missing",
    )
  )
    return "inconclusive";
  return "blocked";
}

function isImprovement(
  baselineMedian: number,
  candidateMedian: number,
  baselineQuartiles: {readonly q1Ms: number; readonly q3Ms: number},
  candidateQuartiles: {readonly q1Ms: number; readonly q3Ms: number},
  policy: {readonly kind: "median-improvement" | "non-overlapping-iqr"; readonly minimumRelativeImprovement: number},
): boolean {
  if (baselineMedian <= 0) return candidateMedian < baselineMedian;
  const threshold = baselineMedian * (1 - policy.minimumRelativeImprovement);
  if (policy.kind === "non-overlapping-iqr")
    return candidateQuartiles.q3Ms < baselineQuartiles.q1Ms && candidateMedian < threshold;
  return candidateMedian < threshold;
}

function comparisonIdFor(
  baseline: string,
  candidate: string,
  workloadDigest: string,
  baselineDigest: string | undefined,
  candidateDigest: string | undefined,
): `cmp_${string}` {
  return `cmp_${createHash("sha256")
    .update(stableJson({baseline, candidate, workload: workloadDigest, baselineDigest, candidateDigest}))
    .digest("hex")
    .slice(0, 16)}`;
}
