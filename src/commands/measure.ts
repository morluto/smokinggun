import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {measureParsedWorkload} from "../execution/measure.js";
import {measureParsedMultiScaling, measureParsedScaling} from "../execution/scaling.js";
import {writeResult} from "../cli/output.js";
import {renderCommandResult} from "../cli/command-output.js";
import {recordInvestigationSnapshot, requireLatestInvestigation} from "../investigations/store.js";
import {createHash} from "node:crypto";
import {comparePortable} from "../paths.js";
import {
  Protocol,
  isMultiScalingWorkload,
  isSingleScalingWorkload,
  type MeasurementV1,
  type ScalingAnalysisV2,
  type ScalingAnalysisV3,
} from "../protocol/index.js";
import {stableJson} from "../serialization.js";

export default class Measure extends BaseCommand {
  static override description = "Measure an investigation only with an explicit workload and execution authorization.";
  static override flags = {
    ...globalFlags,
    execute: Flags.boolean({description: "Authorize local workload execution.", default: false}),
    yes: Flags.boolean({description: "Acknowledge a documented prompt; does not authorize execution.", default: false}),
    workload: Flags.string({description: "WorkloadV2 JSON file."}),
  };
  static override args = {investigation: Args.string({required: true})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Measure);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    if (!parsed.flags.workload || !parsed.flags.execute) {
      this.emitActionRequired(
        {
          schemaVersion: "footgun.action-required.v1",
          reason: "measurement-authorization-required",
          explanation:
            "Measurement requires a workload descriptor and explicit --execute authorization. --yes alone never authorizes workload execution.",
          recoveryCommands: [`smokinggun measure ${parsed.args.investigation} --workload workload.json --execute`],
        },
        context,
      );
    }
    try {
      await requireLatestInvestigation(context.artifacts, parsed.args.investigation);
      const raw = await readFile(parsed.flags.workload, "utf8");
      const parsedWorkload = Protocol.workload.safeParse(JSON.parse(raw) as unknown);
      if (!parsedWorkload.success)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "invalid-workload",
            message: "The workload is not a valid WorkloadV2 descriptor.",
            recovery: "Provide strict JSON with command, cwd, repetitions, timeoutMs, and execution profile.",
          },
          1,
          context,
        );
      const workload = parsedWorkload.data;
      const measurement = isMultiScalingWorkload(workload)
        ? await measureParsedMultiScaling(workload, {
            root: context.config.cwd,
            workspaceRoot: context.artifacts,
            signal: context.signal,
          })
        : isSingleScalingWorkload(workload)
          ? await measureParsedScaling(workload, {
              root: context.config.cwd,
              workspaceRoot: context.artifacts,
              signal: context.signal,
            })
          : await measureParsedWorkload(workload, {
              root: context.config.cwd,
              workspaceRoot: context.artifacts,
              signal: context.signal,
            });
      if ("code" in measurement)
        this.emitProblem(measurement, unavailableExecutionCode(measurement.code) ? 3 : 1, context);
      const storedMeasurement = attachInvestigation(measurement, parsed.args.investigation);
      const id = storedMeasurement.id;
      const directory = join(context.artifacts, "measurements");
      await mkdir(directory, {recursive: true});
      const path = join(directory, `${id}.json`);
      await writeFile(path, `${JSON.stringify(storedMeasurement, null, 2)}\n`, "utf8");
      const measurementDigest = createHash("sha256").update(stableJson(storedMeasurement)).digest("hex");
      const investigation = await requireLatestInvestigation(context.artifacts, parsed.args.investigation);
      const nextBundle = {
        ...investigation.bundle,
        state: "baseline-measured" as const,
        reports: [...new Set([...investigation.bundle.reports, `../measurements/${id}.json`])].sort(comparePortable),
        evidence: [
          ...investigation.bundle.evidence,
          {
            schemaVersion: "footgun.evidence.v2" as const,
            id: `${parsed.args.investigation}:measurement:${id}`,
            kind: "measurement" as const,
            claimClass:
              measurement.schemaVersion === "footgun.scaling.v2" || measurement.schemaVersion === "footgun.scaling.v3"
                ? ("empirical-scaling" as const)
                : ("constant-factor" as const),
            summary:
              measurement.schemaVersion === "footgun.scaling.v2" || measurement.schemaVersion === "footgun.scaling.v3"
                ? "Parameterized scaling measurement"
                : "Repeated local workload measurement",
            artifact: `../measurements/${id}.json`,
            digest: measurementDigest,
          },
        ],
      };
      await recordInvestigationSnapshot(context.artifacts, nextBundle);
      const human =
        measurement.schemaVersion === "footgun.scaling.v2"
          ? `Scaling measurement ${id}\nParameter: ${measurement.parameter}\nPoints: ${measurement.points.length}\nSelected model: ${measurement.selectedModel ?? "inconclusive"}\nArtifact: ${path}`
          : measurement.schemaVersion === "footgun.scaling.v3"
            ? `Scaling measurement ${id}\nParameters: ${measurement.parameters.join(", ")}\nCoordinates: ${measurement.points.length}\nArtifact: ${path}`
            : `Measurement ${id}\nMedian: ${measurement.medianMs.toFixed(3)} ms\nSamples: ${measurement.samplesMs.length}\nBehavior validated: ${measurement.behaviorValidated}\nArtifact: ${path}`;
      const rendered = renderCommandResult(
        {...storedMeasurement, artifact: `${id}.json`},
        human,
        context.config.format,
      );
      await writeResult(rendered, context);
      if (!context.config.quiet || context.config.format !== "human") context.stdout.write(rendered);
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "cancelled",
            message: "The measurement was cancelled.",
            recovery: "Rerun the measurement when the workload is ready.",
          },
          130,
          context,
        );
      const message = cause instanceof Error ? cause.message : "Measurement failed.";
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "measurement-failed",
          message,
          recovery: "Check the WorkloadV2 JSON and rerun with --execute.",
        },
        1,
        context,
      );
    }
  }
}

function attachInvestigation<T extends MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3>(
  value: T,
  investigation: string,
): T & {readonly investigation: string} {
  return {...value, investigation};
}

function unavailableExecutionCode(code: string): boolean {
  return [
    "execution-profile-unavailable",
    "container-runner-missing",
    "container-image-missing",
    "container-image-unpinned",
    "container-runtime-unavailable",
    "sandbox-execution-failed",
    "resource-limit-unavailable",
  ].includes(code);
}
