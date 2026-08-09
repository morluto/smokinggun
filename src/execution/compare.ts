import {createHash} from "node:crypto";
import {stableJson} from "../serialization.js";
import type {
  MeasurementArtifactV1,
  MeasurementComparisonV2,
  MeasurementV1,
  ProblemV1,
  ScalingAnalysisV2,
  ScalingAnalysisV3,
  ScalingComparisonV2,
} from "../protocol/index.js";

export type ComparisonArtifactDigests = readonly [baselineDigest: string, candidateDigest: string];

export type ComparableMeasurementArtifacts =
  | {
      readonly kind: "measurement";
      readonly baseline: MeasurementV1;
      readonly candidate: MeasurementV1;
    }
  | {
      readonly kind: "single-scaling";
      readonly baseline: ScalingAnalysisV2;
      readonly candidate: ScalingAnalysisV2;
    }
  | {
      readonly kind: "multi-scaling";
      readonly baseline: ScalingAnalysisV3;
      readonly candidate: ScalingAnalysisV3;
    };

/** Pair parsed artifacts only when their concrete measurement kind and declared workload agree. */
export function classifyComparableMeasurementArtifacts(
  baseline: MeasurementArtifactV1,
  candidate: MeasurementArtifactV1,
): ComparableMeasurementArtifacts | ProblemV1 {
  switch (baseline.schemaVersion) {
    case "footgun.measurement.v1":
      if (candidate.schemaVersion !== baseline.schemaVersion) return measurementKindMismatch();
      if (baseline.workloadDigest !== candidate.workloadDigest) return workloadMismatch();
      return {kind: "measurement", baseline, candidate};
    case "footgun.scaling.v2":
      if (candidate.schemaVersion !== baseline.schemaVersion) return measurementKindMismatch();
      if (baseline.workloadDigest !== candidate.workloadDigest) return workloadMismatch();
      if (
        baseline.parameter !== candidate.parameter ||
        !sameOrderedValues(
          baseline.points.map((point) => point.value),
          candidate.points.map((point) => point.value),
        )
      )
        return scalingPointPlanMismatch();
      return {kind: "single-scaling", baseline, candidate};
    case "footgun.scaling.v3":
      if (candidate.schemaVersion !== baseline.schemaVersion) return measurementKindMismatch();
      if (baseline.workloadDigest !== candidate.workloadDigest) return workloadMismatch();
      if (
        baseline.parameters.join("\0") !== candidate.parameters.join("\0") ||
        baseline.coordinatesDigest !== candidate.coordinatesDigest ||
        !sameOrderedValues(
          baseline.points.map((point) => canonicalCoordinates(point.coordinates)),
          candidate.points.map((point) => canonicalCoordinates(point.coordinates)),
        )
      )
        return scalingPointPlanMismatch();
      return {kind: "multi-scaling", baseline, candidate};
  }
}

export function buildMeasurementComparison(
  baseline: MeasurementV1,
  candidate: MeasurementV1,
  baselinePath: string,
  candidatePath: string,
  digests?: ComparisonArtifactDigests,
): MeasurementComparisonV2 {
  const [baselineDigest, candidateDigest] = digests ?? [];
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
  const comparison = {
    schemaVersion: "footgun.comparison.v2" as const,
    id: comparisonIdFor(baselinePath, candidatePath, baseline.workloadDigest, baselineDigest, candidateDigest),
    mode: "measurement" as const,
    baseline: baselinePath,
    candidate: candidatePath,
    workloadDigest: baseline.workloadDigest,
    baselineMedianMs: baseline.medianMs,
    candidateMedianMs: candidate.medianMs,
    deltaPercent,
    improvement,
    behaviorValidated: baseline.behaviorValidated && candidate.behaviorValidated,
    statisticalPolicy: baseline.statisticalPolicy,
    comparability: comparability(baseline.environment, candidate.environment),
    promotion: promotionStatus(reasons),
    promotionReasons: reasons,
  };
  if (digests === undefined) return comparison;
  return {...comparison, baselineDigest: digests[0], candidateDigest: digests[1]};
}

export function buildScalingComparison(
  baseline: ScalingAnalysisV2,
  candidate: ScalingAnalysisV2,
  baselinePath: string,
  candidatePath: string,
  digests?: ComparisonArtifactDigests,
): ScalingComparisonV2 {
  const [baselineDigest, candidateDigest] = digests ?? [];
  const firstPoint = baseline.points[0];
  if (firstPoint === undefined) throw new Error("A scaling comparison requires at least one baseline point.");
  const candidateByValue = new Map(candidate.points.map((point) => [point.value, point]));
  const points = baseline.points.map((point) => {
    const other = candidateByValue.get(point.value);
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
  const behaviorValidated =
    baseline.points.every((point) => point.behaviorValidated) &&
    candidate.points.every((point) => point.behaviorValidated);
  const reasons = promotionReasons({
    behaviorValidated,
    improvement,
    comparable: environmentsMatch(baseline.environment, candidate.environment),
    downgradeReasons: [...baseline.points, ...candidate.points].flatMap(
      (point) => point.isolation?.downgradeReasons ?? [],
    ),
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  const comparison = {
    schemaVersion: "footgun.comparison.v2" as const,
    id: comparisonIdFor(baselinePath, candidatePath, baseline.workloadDigest, baselineDigest, candidateDigest),
    mode: "scaling" as const,
    baseline: baselinePath,
    candidate: candidatePath,
    workloadDigest: baseline.workloadDigest,
    behaviorValidated,
    improvement,
    comparability: comparability(baseline.environment, candidate.environment),
    promotion: promotionStatus(reasons),
    promotionReasons: reasons,
    points,
    statisticalPolicy: firstPoint.statisticalPolicy,
    ...(baseline.selectedModel === undefined ? {} : {baselineModel: baseline.selectedModel}),
    ...(candidate.selectedModel === undefined ? {} : {candidateModel: candidate.selectedModel}),
  };
  if (digests === undefined) return comparison;
  return {...comparison, baselineDigest: digests[0], candidateDigest: digests[1]};
}

export function buildMultiScalingComparison(
  baseline: ScalingAnalysisV3,
  candidate: ScalingAnalysisV3,
  baselinePath: string,
  candidatePath: string,
  digests?: ComparisonArtifactDigests,
): ScalingComparisonV2 {
  const [baselineDigest, candidateDigest] = digests ?? [];
  const firstPoint = baseline.points[0];
  if (firstPoint === undefined) throw new Error("A scaling comparison requires at least one baseline point.");
  const candidateByCoordinates = new Map(
    candidate.points.map((point) => [canonicalCoordinates(point.coordinates), point]),
  );
  const points = baseline.points.map((point) => {
    const other = candidateByCoordinates.get(canonicalCoordinates(point.coordinates));
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
    downgradeReasons: [...baseline.points, ...candidate.points].flatMap(
      (point) => point.isolation?.downgradeReasons ?? ["isolation-evidence-missing"],
    ),
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  const comparison = {
    schemaVersion: "footgun.comparison.v2" as const,
    id: comparisonIdFor(baselinePath, candidatePath, baseline.workloadDigest, baselineDigest, candidateDigest),
    mode: "scaling" as const,
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
    points,
    statisticalPolicy: firstPoint.statisticalPolicy,
  };
  if (digests === undefined) return comparison;
  return {...comparison, baselineDigest: digests[0], candidateDigest: digests[1]};
}

type Environment = {readonly node: string; readonly platform: string; readonly arch: string};

function environmentsMatch(left: Environment, right: Environment): boolean {
  return left.node === right.node && left.platform === right.platform && left.arch === right.arch;
}

function comparability(
  left: Environment,
  right: Environment,
): {readonly status: "comparable" | "cross-machine"; readonly reasons: string[]} {
  if (environmentsMatch(left, right)) return {status: "comparable", reasons: []};
  return {
    status: "cross-machine",
    reasons: [
      `Environment differs: Node ${left.node} on ${left.platform}/${left.arch} versus Node ${right.node} on ${right.platform}/${right.arch}.`,
    ],
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

function comparisonProblem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}

function measurementKindMismatch(): ProblemV1 {
  return comparisonProblem(
    "measurement-kind-mismatch",
    "Baseline and candidate artifacts use different measurement kinds.",
    "Compare two MeasurementV1 artifacts or two ScalingAnalysisV2 artifacts.",
  );
}

function workloadMismatch(): ProblemV1 {
  return comparisonProblem(
    "workload-mismatch",
    "Baseline and candidate measurements use different workload digests.",
    "Measure both artifacts from the same immutable WorkloadV2 descriptor.",
  );
}

function scalingPointPlanMismatch(): ProblemV1 {
  return comparisonProblem(
    "scaling-points-mismatch",
    "Baseline and candidate scaling artifacts do not declare the same ordered input points.",
    "Measure both artifacts from the same immutable parameterized WorkloadV2 descriptor.",
  );
}

function sameOrderedValues<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalCoordinates(coordinates: Readonly<Record<string, number>>): string {
  return stableJson(coordinates);
}
