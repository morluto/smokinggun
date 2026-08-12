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

/** Pair imported artifacts only when their concrete measurement kind and benchmark plan agree. */
export function classifyComparableMeasurementArtifacts(
  baseline: MeasurementArtifactV1,
  candidate: MeasurementArtifactV1,
): ComparableMeasurementArtifacts | ProblemV1 {
  switch (baseline.schemaVersion) {
    case "smokinggun.measurement.v1":
      if (candidate.schemaVersion !== baseline.schemaVersion) return measurementKindMismatch();
      if (baseline.benchmarkDigest !== candidate.benchmarkDigest) return benchmarkMismatch();
      return {kind: "measurement", baseline, candidate};
    case "smokinggun.scaling.v2":
      if (candidate.schemaVersion !== baseline.schemaVersion) return measurementKindMismatch();
      if (baseline.benchmarkDigest !== candidate.benchmarkDigest) return benchmarkMismatch();
      if (
        baseline.parameter !== candidate.parameter ||
        !sameOrderedValues(
          baseline.points.map((point) => point.value),
          candidate.points.map((point) => point.value),
        )
      )
        return scalingPointPlanMismatch();
      return {kind: "single-scaling", baseline, candidate};
    case "smokinggun.scaling.v3":
      if (candidate.schemaVersion !== baseline.schemaVersion) return measurementKindMismatch();
      if (baseline.benchmarkDigest !== candidate.benchmarkDigest) return benchmarkMismatch();
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
    inputIdentity: executionInputIdentity(baseline.reproduction, candidate.reproduction),
    runtimeIdentity: runtimeIdentity(baseline.isolation, candidate.isolation),
    downgradeReasons: [...baseline.isolation.downgradeReasons, ...candidate.isolation.downgradeReasons],
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  const comparison = {
    schemaVersion: "smokinggun.comparison.v2" as const,
    id: comparisonIdFor(baselinePath, candidatePath, baseline.benchmarkDigest, baselineDigest, candidateDigest),
    mode: "measurement" as const,
    baseline: baselinePath,
    candidate: candidatePath,
    benchmarkDigest: baseline.benchmarkDigest,
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
        other === undefined || point.status !== "complete" || other.status !== "complete"
          ? false
          : isImprovement(point.medianMs, other.medianMs, point.quartiles, other.quartiles, policy),
      statisticalPolicy: policy,
    };
  });
  const improvement = points.length > 0 && points.every((point) => point.improvement);
  const behaviorValidated =
    baseline.points.every((point) => point.behaviorValidated) &&
    candidate.points.every((point) => point.behaviorValidated);
  const pointsComplete =
    baseline.points.every((point) => point.status === "complete") &&
    candidate.points.every((point) => point.status === "complete");
  const reasons = promotionReasons({
    behaviorValidated: behaviorValidated && pointsComplete,
    improvement,
    comparable: environmentsMatch(baseline.environment, candidate.environment),
    inputIdentity: executionInputIdentity(baseline.reproduction, candidate.reproduction),
    runtimeIdentity: scalingRuntimeIdentity(
      baseline.points.map((point) => ({key: String(point.value), isolation: point.isolation})),
      candidate.points.map((point) => ({key: String(point.value), isolation: point.isolation})),
    ),
    pointsComplete,
    downgradeReasons: [...baseline.points, ...candidate.points].flatMap(
      (point) => point.isolation?.downgradeReasons ?? ["isolation-evidence-missing"],
    ),
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  const comparison = {
    schemaVersion: "smokinggun.comparison.v2" as const,
    id: comparisonIdFor(baselinePath, candidatePath, baseline.benchmarkDigest, baselineDigest, candidateDigest),
    mode: "scaling" as const,
    baseline: baselinePath,
    candidate: candidatePath,
    benchmarkDigest: baseline.benchmarkDigest,
    behaviorValidated: behaviorValidated && pointsComplete,
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
        point.status === "complete" &&
        other.status === "complete" &&
        isImprovement(point.medianMs, other.medianMs, point.quartiles, other.quartiles, point.statisticalPolicy),
      statisticalPolicy: point.statisticalPolicy,
    };
  });
  const improvement = points.length > 0 && points.every((point) => point.improvement);
  const reasons = promotionReasons({
    behaviorValidated:
      baseline.points.every((point) => point.behaviorValidated) &&
      candidate.points.every((point) => point.behaviorValidated) &&
      baseline.points.every((point) => point.status === "complete") &&
      candidate.points.every((point) => point.status === "complete"),
    improvement,
    comparable: environmentsMatch(baseline.environment, candidate.environment),
    inputIdentity: executionInputIdentity(baseline.reproduction, candidate.reproduction),
    runtimeIdentity: scalingRuntimeIdentity(
      baseline.points.map((point) => ({key: canonicalCoordinates(point.coordinates), isolation: point.isolation})),
      candidate.points.map((point) => ({key: canonicalCoordinates(point.coordinates), isolation: point.isolation})),
    ),
    pointsComplete:
      baseline.points.every((point) => point.status === "complete") &&
      candidate.points.every((point) => point.status === "complete"),
    downgradeReasons: [...baseline.points, ...candidate.points].flatMap(
      (point) => point.isolation?.downgradeReasons ?? ["isolation-evidence-missing"],
    ),
    digestsAvailable: baselineDigest !== undefined && candidateDigest !== undefined,
  });
  const comparison = {
    schemaVersion: "smokinggun.comparison.v2" as const,
    id: comparisonIdFor(baselinePath, candidatePath, baseline.benchmarkDigest, baselineDigest, candidateDigest),
    mode: "scaling" as const,
    baseline: baselinePath,
    candidate: candidatePath,
    benchmarkDigest: baseline.benchmarkDigest,
    behaviorValidated:
      baseline.points.every((point) => point.behaviorValidated) &&
      candidate.points.every((point) => point.behaviorValidated) &&
      baseline.points.every((point) => point.status === "complete") &&
      candidate.points.every((point) => point.status === "complete"),
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
  readonly inputIdentity: "matching" | "missing" | "mismatch";
  readonly runtimeIdentity: "matching" | "missing" | "mismatch";
  readonly pointsComplete?: boolean;
  readonly downgradeReasons: ReadonlyArray<string>;
  readonly digestsAvailable: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!input.behaviorValidated) reasons.push("behavior-not-validated");
  if (!input.improvement) reasons.push("configured-statistical-policy-not-met");
  if (!input.comparable) reasons.push("cross-machine-results-not-comparable");
  if (input.inputIdentity === "missing") reasons.push("host-identity-unavailable", "execution-input-identity-missing");
  if (input.inputIdentity === "mismatch") reasons.push("execution-input-identity-mismatch");
  if (input.runtimeIdentity === "missing") reasons.push("runtime-identity-unavailable");
  if (input.runtimeIdentity === "mismatch") reasons.push("runtime-identity-mismatch");
  if (input.pointsComplete === false) reasons.push("scaling-points-incomplete");
  if (input.downgradeReasons.length > 0)
    reasons.push(...input.downgradeReasons.map((reason) => `execution-control-downgrade:${reason}`));
  if (!input.digestsAvailable) reasons.push("immutable-artifact-digests-missing");
  return reasons;
}

type ReproductionIdentity = {
  readonly environmentDigest?: string | undefined;
  readonly executable?: {readonly path: string; readonly digest: string} | undefined;
  readonly subjectDigest?: string | undefined;
  readonly inputSetDigest?: string | undefined;
};

function executionInputIdentity(
  left: ReproductionIdentity | undefined,
  right: ReproductionIdentity | undefined,
): "matching" | "missing" | "mismatch" {
  if (
    left?.environmentDigest === undefined ||
    right?.environmentDigest === undefined ||
    left.executable === undefined ||
    right.executable === undefined ||
    left.subjectDigest === undefined ||
    right.subjectDigest === undefined ||
    left.inputSetDigest === undefined ||
    right.inputSetDigest === undefined
  )
    return "missing";
  return left.environmentDigest === right.environmentDigest &&
    stableJson(left.executable) === stableJson(right.executable) &&
    left.inputSetDigest === right.inputSetDigest
    ? "matching"
    : "mismatch";
}

type IsolationIdentity = {
  readonly backend: string;
  readonly hostDigest?: string | undefined;
  readonly runtime?:
    | {
        readonly name: string;
        readonly version?: string | undefined;
        readonly digest?: string | undefined;
      }
    | undefined;
};

function runtimeIdentity(
  left: IsolationIdentity | undefined,
  right: IsolationIdentity | undefined,
): "matching" | "missing" | "mismatch" {
  if (
    left?.runtime?.digest === undefined ||
    right?.runtime?.digest === undefined ||
    left.hostDigest === undefined ||
    right.hostDigest === undefined
  )
    return "missing";
  return stableJson({backend: left.backend, hostDigest: left.hostDigest, runtime: left.runtime}) ===
    stableJson({backend: right.backend, hostDigest: right.hostDigest, runtime: right.runtime})
    ? "matching"
    : "mismatch";
}

function scalingRuntimeIdentity(
  left: ReadonlyArray<{readonly key: string; readonly isolation?: IsolationIdentity | undefined}>,
  right: ReadonlyArray<{readonly key: string; readonly isolation?: IsolationIdentity | undefined}>,
): "matching" | "missing" | "mismatch" {
  const rightByKey = new Map(right.map((point) => [point.key, point]));
  let hasMissing = false;
  for (const point of left) {
    const identity = runtimeIdentity(point.isolation, rightByKey.get(point.key)?.isolation);
    if (identity === "mismatch") return "mismatch";
    if (identity === "missing") hasMissing = true;
  }
  return hasMissing ? "missing" : "matching";
}

function promotionStatus(reasons: ReadonlyArray<string>): "eligible" | "blocked" | "inconclusive" {
  if (reasons.length === 0) return "eligible";
  if (
    reasons.some(
      (reason) =>
        reason === "cross-machine-results-not-comparable" ||
        reason === "execution-input-identity-mismatch" ||
        reason === "runtime-identity-mismatch" ||
        reason === "scaling-points-incomplete" ||
        reason.startsWith("execution-control-downgrade:"),
    )
  )
    return "blocked";
  return "inconclusive";
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
  benchmarkDigest: string,
  baselineDigest: string | undefined,
  candidateDigest: string | undefined,
): `cmp_${string}` {
  return `cmp_${createHash("sha256")
    .update(stableJson({baseline, candidate, benchmark: benchmarkDigest, baselineDigest, candidateDigest}))
    .digest("hex")
    .slice(0, 16)}`;
}

function comparisonProblem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "smokinggun.problem.v1", code, message, recovery};
}

function measurementKindMismatch(): ProblemV1 {
  return comparisonProblem(
    "measurement-kind-mismatch",
    "Baseline and candidate artifacts use different measurement kinds.",
    "Compare two MeasurementV1 artifacts or two ScalingAnalysisV2 artifacts.",
  );
}

function benchmarkMismatch(): ProblemV1 {
  return comparisonProblem(
    "benchmark-mismatch",
    "Baseline and candidate measurements use different benchmark-plan digests.",
    "Import artifacts produced from the same immutable benchmark plan.",
  );
}

function scalingPointPlanMismatch(): ProblemV1 {
  return comparisonProblem(
    "scaling-points-mismatch",
    "Baseline and candidate scaling artifacts do not declare the same ordered input points.",
    "Import scaling artifacts produced from the same immutable benchmark plan and input points.",
  );
}

function sameOrderedValues<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalCoordinates(coordinates: Readonly<Record<string, number>>): string {
  return stableJson(coordinates);
}
