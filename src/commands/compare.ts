import {Args} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags} from "../cli/base-command.js";
import type {RuntimeContext} from "../cli/context.js";
import {createHash} from "node:crypto";
import {stableJson} from "../serialization.js";
import {writeResult} from "../cli/output.js";
import {renderCommandResult} from "../cli/command-output.js";
import {parseMeasurementArtifact} from "../measurements/artifacts.js";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  loadLatestInvestigation,
  recordImportedInvestigationMeasurements,
  recordParsedInvestigationSnapshot,
  type InvestigationMeasurementImport,
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
} from "../measurements/compare.js";
import {readArtifactBytes} from "../artifacts/store.js";
import {decodeUtf8Bytes} from "../files.js";

export default class Compare extends BaseCommand {
  static override description =
    "Compare immutable baseline and candidate measurement artifacts after behavior validation.";
  static override flags = globalFlags;
  static override args = {baseline: Args.string({required: true}), candidate: Args.string({required: true})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Compare);
    const context = await this.context(parsed.flags);
    try {
      const baselineBytes = await readArtifactBytes(parsed.args.baseline);
      const candidateBytes = await readArtifactBytes(parsed.args.candidate);
      const baseline = parseMeasurementArtifact(JSON.parse(decodeUtf8Bytes(baselineBytes)));
      const candidate = parseMeasurementArtifact(JSON.parse(decodeUtf8Bytes(candidateBytes)));
      if ("code" in baseline) this.emitProblem(baseline, 2, context);
      if ("code" in candidate) this.emitProblem(candidate, 2, context);
      const artifacts = classifyComparableMeasurementArtifacts(baseline, candidate);
      if ("code" in artifacts) this.emitProblem(artifacts, 2, context);
      const inputs: ComparisonInputs = {
        baseline: {path: parsed.args.baseline, bytes: baselineBytes, digest: digest(baselineBytes)},
        candidate: {path: parsed.args.candidate, bytes: candidateBytes, digest: digest(candidateBytes)},
      };
      if (
        artifacts.kind === "measurement" &&
        (artifacts.baseline.statisticalPolicy.kind !== artifacts.candidate.statisticalPolicy.kind ||
          artifacts.baseline.statisticalPolicy.minimumRelativeImprovement !==
            artifacts.candidate.statisticalPolicy.minimumRelativeImprovement)
      )
        this.emitProblem(
          {
            schemaVersion: "smokinggun.problem.v1",
            code: "statistical-policy-mismatch",
            message: "Baseline and candidate measurements use different statistical policies.",
            recovery: "Import artifacts produced with the same benchmark plan and statistical policy.",
          },
          2,
          context,
        );
      if (artifacts.kind === "single-scaling") {
        await this.compareScaling(artifacts.baseline, artifacts.candidate, inputs, context);
        return;
      }
      if (artifacts.kind === "multi-scaling") {
        await this.compareMultiScaling(artifacts.baseline, artifacts.candidate, inputs, context);
        return;
      }
      const {baseline: measurementBaseline, candidate: measurementCandidate} = artifacts;
      if (!measurementBaseline.behaviorValidated || !measurementCandidate.behaviorValidated) {
        this.emitActionRequired(
          {
            schemaVersion: "smokinggun.action-required.v1",
            reason: "behavior-validation-required",
            explanation:
              "The measurement artifacts do not establish behavioral equivalence, so the comparison cannot be promoted.",
            recoveryCommands: [
              "Produce both artifacts with explicit behavior checks, then import and compare them again.",
            ],
          },
          context,
        );
      }
      const result = buildMeasurementComparison(
        measurementBaseline,
        measurementCandidate,
        inputs.baseline.path,
        inputs.candidate.path,
        [inputs.baseline.digest, inputs.candidate.digest],
      );
      await this.storeComparison(result, context, measurementBaseline, measurementCandidate, inputs);
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
            schemaVersion: "smokinggun.problem.v1",
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
          schemaVersion: "smokinggun.problem.v1",
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
    inputs: ComparisonInputs,
    context: RuntimeContext,
  ): Promise<void> {
    if (
      baseline.parameter !== candidate.parameter ||
      baseline.points.length !== candidate.points.length ||
      baseline.points.some((point, index) => point.value !== candidate.points[index]?.value)
    ) {
      this.emitProblem(
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "scaling-points-mismatch",
          message: "Baseline and candidate scaling artifacts do not use the same parameter points.",
          recovery: "Import artifacts produced with the same immutable benchmark plan and scaling points.",
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
          schemaVersion: "smokinggun.problem.v1",
          code: "statistical-policy-mismatch",
          message: "Baseline and candidate scaling points use different statistical policies.",
          recovery: "Import artifacts produced with the same benchmark plan and statistical policy.",
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
          schemaVersion: "smokinggun.action-required.v1",
          reason: "behavior-validation-required",
          explanation: "The scaling artifacts do not establish behavioral equivalence at every input point.",
          recoveryCommands: [
            "Produce both artifacts with explicit behavior checks at every point, then import and compare them again.",
          ],
        },
        context,
      );
    }
    const result = buildScalingComparison(baseline, candidate, inputs.baseline.path, inputs.candidate.path, [
      inputs.baseline.digest,
      inputs.candidate.digest,
    ]);
    await this.storeComparison(result, context, baseline, candidate, inputs);
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
    inputs: ComparisonInputs,
    context: RuntimeContext,
  ): Promise<void> {
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
          schemaVersion: "smokinggun.problem.v1",
          code: "scaling-points-mismatch",
          message: "Baseline and candidate scaling artifacts do not use the same named coordinate grid.",
          recovery: "Import artifacts produced with the same immutable benchmark plan and coordinates.",
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
          schemaVersion: "smokinggun.problem.v1",
          code: "statistical-policy-mismatch",
          message: "Baseline and candidate scaling coordinates use different statistical policies.",
          recovery: "Import artifacts produced with the same benchmark plan and statistical policy.",
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
          schemaVersion: "smokinggun.action-required.v1",
          reason: "behavior-validation-required",
          explanation: "The scaling artifacts do not establish behavioral equivalence at every coordinate.",
          recoveryCommands: [
            "Produce both artifacts with explicit behavior checks at every coordinate, then import and compare them again.",
          ],
        },
        context,
      );
    const result = buildMultiScalingComparison(baseline, candidate, inputs.baseline.path, inputs.candidate.path, [
      inputs.baseline.digest,
      inputs.candidate.digest,
    ]);
    await this.storeComparison(result, context, baseline, candidate, inputs);
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
    inputs: ComparisonInputs,
  ): Promise<void> {
    const comparison = Protocol.comparison.parse(result);
    await this.importInvestigationMeasurements(context, baseline, candidate, inputs);
    const artifact = `${comparison.id}.json`;
    const comparisonBytes = Buffer.from(`${stableJson(comparison)}\n`, "utf8");
    const storedArtifact = await context.artifactStore.putBytes(artifact, comparisonBytes);
    const report = storedArtifact.reference;
    const investigationIds = [
      ...new Set(
        [baseline.investigation, candidate.investigation].filter((value): value is string => value !== undefined),
      ),
    ];
    const pending = [];
    for (const investigationId of investigationIds) {
      const investigation = await loadLatestInvestigation(context.artifacts, investigationId);
      if (investigation === undefined) continue;
      const baselineInputDigest = "baselineDigest" in comparison ? comparison.baselineDigest : undefined;
      const candidateInputDigest = "candidateDigest" in comparison ? comparison.candidateDigest : undefined;
      const requiredInputDigests = [
        ...(baseline.investigation === investigationId && baselineInputDigest !== undefined
          ? [baselineInputDigest]
          : []),
        ...(candidate.investigation === investigationId && candidateInputDigest !== undefined
          ? [candidateInputDigest]
          : []),
      ];
      const retainedDigests = new Set(
        investigation.bundle.evidence.flatMap((evidence) =>
          evidence.kind === "measurement" && evidence.digest !== undefined ? [evidence.digest] : [],
        ),
      );
      const missingInput = requiredInputDigests.find((digest) => !retainedDigests.has(digest));
      if (missingInput !== undefined)
        throw new Error(
          `Investigation ${investigationId} does not retain measurement input ${missingInput}; comparisons cannot attach unrelated artifacts.`,
        );
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
      pending.push({investigationId, bundle: investigation.bundle, parentDigest: investigation.digest});
    }
    for (const {investigationId, bundle, parentDigest} of pending) {
      const candidateCompared = {
        ...bundle,
        state: "candidate-compared" as const,
        reports: appendInvestigationReport(bundle.reports, report),
        evidence: appendInvestigationEvidence(bundle.evidence, {
          schemaVersion: "smokinggun.evidence.v2" as const,
          id: `${investigationId}:comparison:${comparison.id}`,
          kind: "behavior" as const,
          claimClass: "behavioral" as const,
          summary: "Baseline and candidate comparison completed after declared behavior checks",
          artifact: report,
          digest: storedArtifact.digest,
        }),
      };
      const candidateDigest = await recordParsedInvestigationSnapshot(
        context.artifacts,
        candidateCompared,
        parentDigest,
      );
      await recordParsedInvestigationSnapshot(
        context.artifacts,
        {
          ...candidateCompared,
          state: "behavior-validated",
          evidence: appendInvestigationEvidence(candidateCompared.evidence, {
            schemaVersion: "smokinggun.evidence.v2" as const,
            id: `${investigationId}:comparison:${comparison.id}:validated`,
            kind: "behavior" as const,
            claimClass: "behavioral" as const,
            summary: "Baseline and candidate comparison passed declared behavior checks",
            artifact: report,
            digest: storedArtifact.digest,
          }),
        },
        candidateDigest,
      );
    }
  }

  private async importInvestigationMeasurements(
    context: RuntimeContext,
    baseline: MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3,
    candidate: MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3,
    inputs: ComparisonInputs,
  ): Promise<void> {
    const investigationIds = [
      ...new Set(
        [baseline.investigation, candidate.investigation].filter((value): value is string => value !== undefined),
      ),
    ];
    for (const investigationId of investigationIds) {
      if ((await loadLatestInvestigation(context.artifacts, investigationId)) === undefined) continue;
      const imports: InvestigationMeasurementImport[] = [];
      const storedBaseline = await context.artifactStore.putBytes(inputs.baseline.path, inputs.baseline.bytes);
      if (storedBaseline.digest !== inputs.baseline.digest)
        throw new Error("The artifact store changed baseline measurement bytes.");
      imports.push({
        role: "baseline",
        artifact: storedBaseline.reference,
        digest: storedBaseline.digest,
        claimClass: measurementClaimClass(baseline),
      });
      const storedCandidate = await context.artifactStore.putBytes(inputs.candidate.path, inputs.candidate.bytes);
      if (storedCandidate.digest !== inputs.candidate.digest)
        throw new Error("The artifact store changed candidate measurement bytes.");
      imports.push({
        role: "candidate",
        artifact: storedCandidate.reference,
        digest: storedCandidate.digest,
        claimClass: measurementClaimClass(candidate),
      });
      await recordImportedInvestigationMeasurements(context.artifacts, investigationId, imports);
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

type ComparisonInput = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
};

type ComparisonInputs = {
  readonly baseline: ComparisonInput;
  readonly candidate: ComparisonInput;
};

function measurementClaimClass(
  measurement: MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3,
): "constant-factor" | "empirical-scaling" {
  return measurement.schemaVersion === "smokinggun.measurement.v1" ? "constant-factor" : "empirical-scaling";
}
