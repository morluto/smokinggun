import {Args} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import type {RuntimeContext} from "../cli/context.js";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {stableJson} from "../serialization.js";
import {join} from "node:path";
import {writeResult} from "../cli/output.js";
import {renderCommandResult} from "../cli/command-output.js";
import {parseMeasurementArtifact} from "../execution/measure.js";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  loadLatestInvestigation,
  recordParsedInvestigationSnapshot,
} from "../investigations/store.js";
import {
  Protocol,
  type ComparisonV2,
  type MeasurementV1,
  type ScalingAnalysisV2,
  type ScalingAnalysisV3,
} from "../protocol/index.js";
import {
  buildMeasurementComparison,
  buildMultiScalingComparison,
  buildScalingComparison,
  classifyComparableMeasurementArtifacts,
  type ComparisonArtifactDigests,
} from "../execution/compare.js";
import {writeFileAtomically} from "../files.js";

export default class Compare extends BaseCommand {
  static override description =
    "Compare immutable baseline and candidate measurement artifacts after behavior validation.";
  static override flags = globalFlags;
  static override args = {baseline: Args.string({required: true}), candidate: Args.string({required: true})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Compare);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    try {
      const baselineBytes = await readFile(parsed.args.baseline);
      const candidateBytes = await readFile(parsed.args.candidate);
      const baseline = parseMeasurementArtifact(JSON.parse(baselineBytes.toString("utf8")));
      const candidate = parseMeasurementArtifact(JSON.parse(candidateBytes.toString("utf8")));
      if ("code" in baseline) this.emitProblem(baseline, 2, context);
      if ("code" in candidate) this.emitProblem(candidate, 2, context);
      const artifacts = classifyComparableMeasurementArtifacts(baseline, candidate);
      if ("code" in artifacts) this.emitProblem(artifacts, 2, context);
      if (
        artifacts.kind === "measurement" &&
        (artifacts.baseline.statisticalPolicy.kind !== artifacts.candidate.statisticalPolicy.kind ||
          artifacts.baseline.statisticalPolicy.minimumRelativeImprovement !==
            artifacts.candidate.statisticalPolicy.minimumRelativeImprovement)
      )
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "statistical-policy-mismatch",
            message: "Baseline and candidate measurements use different statistical policies.",
            recovery: "Measure both artifacts from the same WorkloadV2 descriptor and policy.",
          },
          2,
          context,
        );
      if (artifacts.kind === "single-scaling") {
        await this.compareScaling(
          artifacts.baseline,
          artifacts.candidate,
          parsed.args.baseline,
          parsed.args.candidate,
          [digest(baselineBytes), digest(candidateBytes)],
          context,
        );
        return;
      }
      if (artifacts.kind === "multi-scaling") {
        await this.compareMultiScaling(
          artifacts.baseline,
          artifacts.candidate,
          parsed.args.baseline,
          parsed.args.candidate,
          [digest(baselineBytes), digest(candidateBytes)],
          context,
        );
        return;
      }
      const {baseline: measurementBaseline, candidate: measurementCandidate} = artifacts;
      if (!measurementBaseline.behaviorValidated || !measurementCandidate.behaviorValidated) {
        this.emitActionRequired(
          {
            schemaVersion: "footgun.action-required.v1",
            reason: "behavior-validation-required",
            explanation:
              "The measurement artifacts do not establish behavioral equivalence, so the comparison cannot be promoted.",
            recoveryCommands: [
              "Add explicit behavior checks to WorkloadV2, validate them, then rerun measure and compare.",
            ],
          },
          context,
        );
      }
      const result = buildMeasurementComparison(
        measurementBaseline,
        measurementCandidate,
        parsed.args.baseline,
        parsed.args.candidate,
        [digest(baselineBytes), digest(candidateBytes)],
      );
      await this.storeComparison(result, context, measurementBaseline, measurementCandidate);
      await this.writeComparison(
        result,
        `Comparison\nBaseline median: ${measurementBaseline.medianMs.toFixed(3)} ms\nCandidate median: ${measurementCandidate.medianMs.toFixed(3)} ms\nChange: ${result.deltaPercent?.toFixed(2) ?? "n/a"}%`,
        context,
      );
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "cancelled",
            message: "The comparison was cancelled.",
            recovery: "Rerun the comparison when both artifacts are available.",
          },
          130,
          context,
        );
      const message = cause instanceof Error ? cause.message : "Comparison failed.";
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "comparison-failed",
          message,
          recovery: "Pass two valid MeasurementV1 or ScalingAnalysisV2 JSON artifacts.",
        },
        2,
        context,
      );
    }
  }

  private async compareScaling(
    baseline: ScalingAnalysisV2,
    candidate: ScalingAnalysisV2,
    baselinePath: string,
    candidatePath: string,
    digests: ComparisonArtifactDigests,
    context: RuntimeContext,
  ): Promise<void> {
    const [baselineDigest, candidateDigest] = digests;
    if (
      baseline.parameter !== candidate.parameter ||
      baseline.points.length !== candidate.points.length ||
      baseline.points.some((point, index) => point.value !== candidate.points[index]?.value)
    ) {
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "scaling-points-mismatch",
          message: "Baseline and candidate scaling artifacts do not use the same parameter points.",
          recovery: "Measure both artifacts from the same immutable parameterized WorkloadV2 descriptor.",
        },
        2,
        context,
      );
    }
    if (
      baseline.points.some(
        (point, index) =>
          point.statisticalPolicy.kind !== candidate.points[index]?.statisticalPolicy.kind ||
          point.statisticalPolicy.minimumRelativeImprovement !==
            candidate.points[index]?.statisticalPolicy.minimumRelativeImprovement,
      )
    )
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "statistical-policy-mismatch",
          message: "Baseline and candidate scaling points use different statistical policies.",
          recovery: "Measure both artifacts from the same parameterized WorkloadV2 descriptor and policy.",
        },
        2,
        context,
      );
    if (
      !baseline.points.every((point) => point.behaviorValidated) ||
      !candidate.points.every((point) => point.behaviorValidated)
    ) {
      this.emitActionRequired(
        {
          schemaVersion: "footgun.action-required.v1",
          reason: "behavior-validation-required",
          explanation: "The scaling artifacts do not establish behavioral equivalence at every input point.",
          recoveryCommands: [
            "Add explicit behavior checks to WorkloadV2, validate every point, then rerun measure and compare.",
          ],
        },
        context,
      );
    }
    const result = buildScalingComparison(baseline, candidate, baselinePath, candidatePath, [
      baselineDigest,
      candidateDigest,
    ]);
    await this.storeComparison(result, context, baseline, candidate);
    const improved = result.points?.filter((point) => point.improvement).length ?? 0;
    await this.writeComparison(
      result,
      `Scaling comparison\nParameter: ${baseline.parameter}\nImproved points: ${improved}/${result.points?.length ?? 0}\nBaseline model: ${baseline.selectedModel ?? "inconclusive"}\nCandidate model: ${candidate.selectedModel ?? "inconclusive"}`,
      context,
    );
  }

  private async compareMultiScaling(
    baseline: ScalingAnalysisV3,
    candidate: ScalingAnalysisV3,
    baselinePath: string,
    candidatePath: string,
    digests: ComparisonArtifactDigests,
    context: RuntimeContext,
  ): Promise<void> {
    const [baselineDigest, candidateDigest] = digests;
    const baselineCoordinates = baseline.points.map((point) => point.coordinates);
    const candidateCoordinates = candidate.points.map((point) => point.coordinates);
    const computedBaselineCoordinatesDigest = createHash("sha256")
      .update(stableJson(baselineCoordinates))
      .digest("hex");
    const computedCandidateCoordinatesDigest = createHash("sha256")
      .update(stableJson(candidateCoordinates))
      .digest("hex");
    if (
      baseline.coordinatesDigest !== computedBaselineCoordinatesDigest ||
      candidate.coordinatesDigest !== computedCandidateCoordinatesDigest ||
      computedBaselineCoordinatesDigest !== computedCandidateCoordinatesDigest ||
      stableJson(baselineCoordinates) !== stableJson(candidateCoordinates) ||
      baseline.parameters.join("\0") !== candidate.parameters.join("\0")
    )
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "scaling-points-mismatch",
          message: "Baseline and candidate scaling artifacts do not use the same named coordinate grid.",
          recovery: "Measure both artifacts from the same immutable multi-parameter workload descriptor.",
        },
        2,
        context,
      );
    if (
      baseline.points.some(
        (point, index) =>
          point.statisticalPolicy.kind !== candidate.points[index]?.statisticalPolicy.kind ||
          point.statisticalPolicy.minimumRelativeImprovement !==
            candidate.points[index]?.statisticalPolicy.minimumRelativeImprovement,
      )
    )
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "statistical-policy-mismatch",
          message: "Baseline and candidate scaling coordinates use different statistical policies.",
          recovery: "Measure both artifacts from the same immutable multi-parameter workload descriptor and policy.",
        },
        2,
        context,
      );
    if (
      !baseline.points.every((point) => point.behaviorValidated) ||
      !candidate.points.every((point) => point.behaviorValidated)
    )
      this.emitActionRequired(
        {
          schemaVersion: "footgun.action-required.v1",
          reason: "behavior-validation-required",
          explanation: "The scaling artifacts do not establish behavioral equivalence at every coordinate.",
          recoveryCommands: [
            "Add explicit behavior checks to WorkloadV2, validate every coordinate, then rerun measure and compare.",
          ],
        },
        context,
      );
    const result = buildMultiScalingComparison(baseline, candidate, baselinePath, candidatePath, [
      baselineDigest,
      candidateDigest,
    ]);
    await this.storeComparison(result, context, baseline, candidate);
    const improved = result.points?.filter((point) => point.improvement).length ?? 0;
    await this.writeComparison(
      result,
      `Multi-parameter scaling comparison\nParameters: ${baseline.parameters.join(", ")}\nImproved coordinates: ${improved}/${result.points?.length ?? 0}`,
      context,
    );
  }

  private async storeComparison(
    result: ComparisonV2,
    context: RuntimeContext,
    baseline: MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3,
    candidate: MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3,
  ): Promise<void> {
    const comparison = Protocol.comparison.parse(result);
    const directory = join(context.artifacts, "comparisons");
    const artifact = `${comparison.id}.json`;
    const report = `../comparisons/${artifact}`;
    const investigationIds = [
      ...new Set(
        [baseline.investigation, candidate.investigation].filter((value): value is string => value !== undefined),
      ),
    ];
    const pending = [];
    for (const investigationId of investigationIds) {
      const investigation = await loadLatestInvestigation(context.artifacts, investigationId);
      if (investigation === undefined) continue;
      if (investigation.bundle.state === "behavior-validated") {
        const comparisonEvidenceId = `${investigationId}:comparison:${comparison.id}`;
        const validationEvidenceId = `${comparisonEvidenceId}:validated`;
        const reportPaths = new Set(investigation.bundle.reports);
        const evidenceIds = new Set(investigation.bundle.evidence.map((evidence) => evidence.id));
        const isSameComparison =
          reportPaths.has(report) && evidenceIds.has(comparisonEvidenceId) && evidenceIds.has(validationEvidenceId);
        if (isSameComparison) continue;
        throw new Error(
          `Investigation ${investigationId} is already behavior-validated and cannot record comparison ${comparison.id}.`,
        );
      }
      if (investigation.bundle.state !== "baseline-measured" && investigation.bundle.state !== "candidate-compared")
        throw new Error(
          `Investigation ${investigationId} must be baseline-measured before recording comparison ${comparison.id}.`,
        );
      pending.push({investigationId, bundle: investigation.bundle});
    }
    await writeFileAtomically(join(directory, artifact), `${JSON.stringify(comparison, null, 2)}\n`);
    for (const {investigationId, bundle} of pending) {
      const candidateCompared = {
        ...bundle,
        state: "candidate-compared" as const,
        reports: appendInvestigationReport(bundle.reports, report),
        evidence: appendInvestigationEvidence(bundle.evidence, {
          schemaVersion: "footgun.evidence.v2" as const,
          id: `${investigationId}:comparison:${comparison.id}`,
          kind: "behavior" as const,
          claimClass: "behavioral" as const,
          summary: "Baseline and candidate comparison completed after declared behavior checks",
          artifact: report,
        }),
      };
      await recordParsedInvestigationSnapshot(context.artifacts, candidateCompared);
      await recordParsedInvestigationSnapshot(context.artifacts, {
        ...candidateCompared,
        state: "behavior-validated",
        evidence: appendInvestigationEvidence(candidateCompared.evidence, {
          schemaVersion: "footgun.evidence.v2" as const,
          id: `${investigationId}:comparison:${comparison.id}:validated`,
          kind: "behavior" as const,
          claimClass: "behavioral" as const,
          summary: "Baseline and candidate comparison passed declared behavior checks",
          artifact: report,
        }),
      });
    }
  }

  private async writeComparison(result: ComparisonV2, human: string, context: RuntimeContext): Promise<void> {
    const rendered = renderCommandResult(result, human, context.config.format);
    await writeResult(rendered, context);
    if (!context.config.quiet || context.config.format !== "human") context.stdout.write(rendered);
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
