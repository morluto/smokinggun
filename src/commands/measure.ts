import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {measureWorkload} from "../execution/measure.js";
import {measureScaling} from "../execution/scaling.js";
import {writeResult} from "../cli/output.js";
import {renderCommandResult} from "../cli/command-output.js";
import {loadLatestInvestigation, recordInvestigationSnapshot} from "../investigations/store.js";
import {createHash} from "node:crypto";
import {comparePortable} from "../paths.js";
import type {MeasurementV1, ScalingAnalysisV1} from "../protocol/index.js";
import {stableJson} from "../serialization.js";

export default class Measure extends BaseCommand {
  static override description = "Measure an investigation only with an explicit workload and execution authorization.";
  static override flags = {
    ...globalFlags,
    execute: Flags.boolean({description: "Authorize local workload execution.", default: false}),
    yes: Flags.boolean({description: "Acknowledge a documented prompt; does not authorize execution.", default: false}),
    workload: Flags.string({description: "WorkloadV1 JSON file."}),
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
      const raw = await readFile(parsed.flags.workload, "utf8");
      const workload: unknown = JSON.parse(raw);
      const measurement =
        typeof workload === "object" &&
        workload !== null &&
        "inputSizeParameterization" in workload &&
        workload.inputSizeParameterization !== undefined
          ? await measureScaling(workload, {
              root: context.config.cwd,
              workspaceRoot: context.artifacts,
              signal: context.signal,
            })
          : await measureWorkload(workload, {
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
      const investigation = await loadLatestInvestigation(context.artifacts, parsed.args.investigation);
      if (investigation !== undefined) {
        const measurementDigest = createHash("sha256").update(stableJson(storedMeasurement)).digest("hex");
        const nextBundle = {
          ...investigation.bundle,
          state: "baseline-measured" as const,
          reports: [...new Set([...investigation.bundle.reports, `../measurements/${id}.json`])].sort(comparePortable),
          evidence: [
            ...investigation.bundle.evidence,
            {
              schemaVersion: "footgun.evidence.v1" as const,
              id: `${parsed.args.investigation}:measurement:${id}`,
              kind: "measurement" as const,
              claimClass:
                measurement.schemaVersion === "footgun.scaling.v1"
                  ? ("empirical-scaling" as const)
                  : ("constant-factor" as const),
              summary:
                measurement.schemaVersion === "footgun.scaling.v1"
                  ? "Parameterized scaling measurement"
                  : "Repeated local workload measurement",
              artifact: `../measurements/${id}.json`,
              digest: measurementDigest,
            },
          ],
        };
        await recordInvestigationSnapshot(context.artifacts, nextBundle);
      }
      const human =
        measurement.schemaVersion === "footgun.scaling.v1"
          ? `Scaling measurement ${id}\nParameter: ${measurement.parameter}\nPoints: ${measurement.points.length}\nSelected model: ${measurement.selectedModel ?? "inconclusive"}\nArtifact: ${path}`
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
          recovery: "Check the WorkloadV1 JSON and rerun with --execute.",
        },
        1,
        context,
      );
    }
  }
}

function attachInvestigation(
  value: MeasurementV1 | ScalingAnalysisV1,
  investigation: string,
): (MeasurementV1 | ScalingAnalysisV1) & {readonly investigation: string} {
  if (value.schemaVersion === "footgun.measurement.v1") return {...value, investigation};
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
