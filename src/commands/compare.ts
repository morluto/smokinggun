import {Args} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import type {RuntimeContext} from "../cli/context.js";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {writeResult} from "../cli/output.js";
import {renderCommandResult} from "../cli/command-output.js";
import {parseMeasurementArtifact} from "../execution/measure.js";
import {loadLatestInvestigation, recordInvestigationSnapshot} from "../investigations/store.js";
import {comparePortable} from "../paths.js";
import {Protocol, type ComparisonV1, type MeasurementV1, type ScalingAnalysisV1} from "../protocol/index.js";
import {buildMeasurementComparison, buildScalingComparison} from "../execution/compare.js";

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
      if (baseline.schemaVersion !== candidate.schemaVersion)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "measurement-kind-mismatch",
            message: "Baseline and candidate artifacts use different measurement kinds.",
            recovery: "Compare two MeasurementV1 artifacts or two ScalingAnalysisV1 artifacts.",
          },
          2,
          context,
        );
      if (baseline.workloadDigest !== candidate.workloadDigest)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "workload-mismatch",
            message: "Baseline and candidate measurements use different workload digests.",
            recovery: "Measure both artifacts from the same immutable WorkloadV1 descriptor.",
          },
          2,
          context,
        );
      if (
        baseline.schemaVersion === "footgun.measurement.v1" &&
        candidate.schemaVersion === "footgun.measurement.v1" &&
        (baseline.statisticalPolicy.kind !== candidate.statisticalPolicy.kind ||
          baseline.statisticalPolicy.minimumRelativeImprovement !==
            candidate.statisticalPolicy.minimumRelativeImprovement)
      )
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "statistical-policy-mismatch",
            message: "Baseline and candidate measurements use different statistical policies.",
            recovery: "Measure both artifacts from the same WorkloadV1 descriptor and policy.",
          },
          2,
          context,
        );
      if (baseline.schemaVersion === "footgun.scaling.v1" && candidate.schemaVersion === "footgun.scaling.v1") {
        await this.compareScaling(
          baseline,
          candidate,
          parsed.args.baseline,
          parsed.args.candidate,
          digest(baselineBytes),
          digest(candidateBytes),
          context,
        );
        return;
      }
      if (baseline.schemaVersion !== "footgun.measurement.v1" || candidate.schemaVersion !== "footgun.measurement.v1")
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "measurement-kind-mismatch",
            message: "Baseline and candidate artifacts use different measurement kinds.",
            recovery: "Compare two MeasurementV1 artifacts or two ScalingAnalysisV1 artifacts.",
          },
          2,
          context,
        );
      if (!baseline.behaviorValidated || !candidate.behaviorValidated) {
        this.emitActionRequired(
          {
            schemaVersion: "footgun.action-required.v1",
            reason: "behavior-validation-required",
            explanation:
              "The measurement artifacts do not establish behavioral equivalence, so the comparison cannot be promoted.",
            recoveryCommands: [
              "Add explicit behavior checks to WorkloadV1, validate them, then rerun measure and compare.",
            ],
          },
          context,
        );
      }
      const result = buildMeasurementComparison(
        baseline,
        candidate,
        parsed.args.baseline,
        parsed.args.candidate,
        digest(baselineBytes),
        digest(candidateBytes),
      );
      await this.storeComparison(result, context, baseline, candidate);
      await this.writeComparison(
        result,
        `Comparison\nBaseline median: ${baseline.medianMs.toFixed(3)} ms\nCandidate median: ${candidate.medianMs.toFixed(3)} ms\nChange: ${result.deltaPercent?.toFixed(2) ?? "n/a"}%`,
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
          recovery: "Pass two valid MeasurementV1 or ScalingAnalysisV1 JSON artifacts.",
        },
        2,
        context,
      );
    }
  }

  private async compareScaling(
    baseline: ScalingAnalysisV1,
    candidate: ScalingAnalysisV1,
    baselinePath: string,
    candidatePath: string,
    baselineDigest: string,
    candidateDigest: string,
    context: RuntimeContext,
  ): Promise<void> {
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
          recovery: "Measure both artifacts from the same immutable parameterized WorkloadV1 descriptor.",
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
          recovery: "Measure both artifacts from the same parameterized WorkloadV1 descriptor and policy.",
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
            "Add explicit behavior checks to WorkloadV1, validate every point, then rerun measure and compare.",
          ],
        },
        context,
      );
    }
    const result = buildScalingComparison(
      baseline,
      candidate,
      baselinePath,
      candidatePath,
      baselineDigest,
      candidateDigest,
    );
    await this.storeComparison(result, context, baseline, candidate);
    const improved = result.points?.filter((point) => point.improvement).length ?? 0;
    await this.writeComparison(
      result,
      `Scaling comparison\nParameter: ${baseline.parameter}\nImproved points: ${improved}/${result.points?.length ?? 0}\nBaseline model: ${baseline.selectedModel ?? "inconclusive"}\nCandidate model: ${candidate.selectedModel ?? "inconclusive"}`,
      context,
    );
  }

  private async storeComparison(
    result: ComparisonV1,
    context: RuntimeContext,
    baseline: MeasurementV1 | ScalingAnalysisV1,
    candidate: MeasurementV1 | ScalingAnalysisV1,
  ): Promise<void> {
    const validated = Protocol.comparison.parse(result);
    const directory = join(context.artifacts, "comparisons");
    await mkdir(directory, {recursive: true});
    const artifact = `${result.id}.json`;
    await writeFile(join(directory, artifact), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    const investigationIds = [
      ...new Set(
        [baseline.investigation, candidate.investigation].filter((value): value is string => value !== undefined),
      ),
    ];
    for (const investigationId of investigationIds) {
      const investigation = await loadLatestInvestigation(context.artifacts, investigationId);
      if (investigation === undefined) continue;
      const candidateCompared = {
        ...investigation.bundle,
        state: "candidate-compared" as const,
        reports: [...new Set([...investigation.bundle.reports, `../comparisons/${artifact}`])].sort(comparePortable),
        evidence: [
          ...investigation.bundle.evidence,
          {
            schemaVersion: "footgun.evidence.v1" as const,
            id: `${investigationId}:comparison:${result.id}`,
            kind: "behavior" as const,
            claimClass: "behavioral" as const,
            summary: "Baseline and candidate comparison completed after declared behavior checks",
            artifact: `../comparisons/${artifact}`,
          },
        ],
      };
      await recordInvestigationSnapshot(context.artifacts, candidateCompared);
      await recordInvestigationSnapshot(context.artifacts, {
        ...candidateCompared,
        state: "behavior-validated",
        evidence: [
          ...candidateCompared.evidence,
          {
            schemaVersion: "footgun.evidence.v1" as const,
            id: `${investigationId}:comparison:${result.id}:validated`,
            kind: "behavior" as const,
            claimClass: "behavioral" as const,
            summary: "Baseline and candidate comparison passed declared behavior checks",
            artifact: `../comparisons/${artifact}`,
          },
        ],
      });
    }
  }

  private async writeComparison(result: ComparisonV1, human: string, context: RuntimeContext): Promise<void> {
    const rendered = renderCommandResult(result, human, context.config.format);
    await writeResult(rendered, context);
    if (!context.config.quiet || context.config.format !== "human") context.stdout.write(rendered);
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
