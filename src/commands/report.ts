import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags} from "../cli/base-command.js";
import {renderScanReport} from "../reports/render.js";
import {parseScanReport} from "../protocol/index.js";
import {writeResult, shouldPrint} from "../cli/output.js";
import {importSarif} from "../adapters/sarif.js";
import {importBenchmark, type BenchmarkTool} from "../adapters/benchmarks.js";
import {importPerfettoSummary, importPerfettoTrace, importPprof, validatePerfettoQuery} from "../adapters/profiles.js";
import {printResult} from "../cli/command-output.js";
import {createHash} from "node:crypto";
import type {RuntimeContext} from "../cli/context.js";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  canAttachReport,
  loadLatestInvestigation,
  recordParsedInvestigationSnapshot,
} from "../investigations/store.js";
import {z} from "zod";
import {readArtifactBytes} from "../artifacts/store.js";

export default class Report extends BaseCommand {
  static override description = "Render a normalized scan artifact.";
  static override flags = {
    ...globalFlags,
    benchmark: Flags.string({
      description: "Interpret the artifact as standard benchmark JSON.",
      options: ["hyperfine", "pyperf", "google-benchmark", "criterion", "jmh"],
    }),
    profile: Flags.string({
      description: "Interpret the artifact as a pprof or Perfetto summary/trace.",
      options: ["pprof", "perfetto"],
    }),
    "trace-query": Flags.string({
      description: "Bounded Perfetto SQL query for a raw trace; defaults to a 1,000-row slice query.",
      default: "SELECT ts, dur, name FROM slice LIMIT 1000",
    }),
    investigation: Flags.string({description: "Attach the rendered artifact to an investigation bundle."}),
  };
  static override args = {artifact: Args.string({required: true})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Report);
    const context = await this.context(parsed.flags);
    try {
      if (parsed.flags.investigation !== undefined) {
        try {
          const investigation = await loadLatestInvestigation(context.artifacts, parsed.flags.investigation);
          if (investigation === undefined)
            throw new Error(`Investigation ${parsed.flags.investigation} does not exist.`);
          if (!canAttachReport(investigation.bundle))
            throw new Error(
              `Investigation ${parsed.flags.investigation} is in ${investigation.bundle.state} state and cannot accept reports.`,
            );
        } catch (cause: unknown) {
          this.emitProblem(
            {
              schemaVersion: "smokinggun.problem.v1",
              code: "investigation-unavailable",
              message: "The requested investigation is invalid or does not exist.",
              ...(cause instanceof Error ? {detail: cause.message} : {}),
              recovery: "Create or select an existing investigation before attaching this report.",
            },
            2,
            context,
          );
        }
      }
      if (parsed.flags.benchmark !== undefined && parsed.flags.profile !== undefined)
        this.emitProblem(
          {
            schemaVersion: "smokinggun.problem.v1",
            code: "report-input-kind-conflict",
            message: "Choose one external artifact kind for report.",
            recovery: "Pass either --benchmark or --profile, not both.",
          },
          2,
          context,
        );
      const artifactBytes = await readArtifactBytes(parsed.args.artifact);
      const raw = artifactBytes.toString("utf8");
      const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");
      const artifactReference = `artifact://sha256/${artifactDigest}`;
      const storeValidatedArtifact = async () => {
        const stored = await context.artifactStore.putBytes(parsed.args.artifact, artifactBytes);
        if (stored.reference !== artifactReference || stored.digest !== artifactDigest)
          throw new Error("The artifact store did not preserve the validated input bytes.");
        return stored;
      };
      const input: unknown =
        parsed.flags.profile === "pprof" || (parsed.flags.profile === "perfetto" && !looksLikeJson(raw))
          ? undefined
          : JSON.parse(raw);
      if (parsed.flags.benchmark !== undefined) {
        const tool = parsed.flags.benchmark;
        if (!isBenchmarkTool(tool))
          this.emitProblem(
            {
              schemaVersion: "smokinggun.problem.v1",
              code: "invalid-benchmark-tool",
              message: "The benchmark tool is not supported by this SmokingGun build.",
              recovery: "Choose hyperfine, pyperf, google-benchmark, criterion, or jmh.",
            },
            2,
            context,
          );
        const benchmark = importBenchmark(input, {
          tool,
          rawArtifact: artifactReference,
          rawArtifactDigest: artifactDigest,
        });
        if ("code" in benchmark) this.emitProblem(benchmark, 2, context);
        await storeValidatedArtifact();
        await printResult(
          benchmark,
          `Imported ${benchmark.tool} benchmark records: ${benchmark.records.length}`,
          context,
        );
        await recordReportedArtifact(context, parsed.flags.investigation, artifactReference, "benchmark");
        return;
      }
      if (parsed.flags.profile !== undefined) {
        const sourceArtifact = artifactReference;
        if (parsed.flags.profile === "pprof") {
          const profile = importPprof(artifactBytes, {sourceArtifact});
          if ("code" in profile) this.emitProblem(profile, 2, context);
          await storeValidatedArtifact();
          await printResult(
            profile,
            `Imported pprof profile: ${profile.sampleCount} samples, ${profile.topFunctions.length} top functions`,
            context,
          );
          await recordReportedArtifact(context, parsed.flags.investigation, sourceArtifact, "profile");
        } else {
          const sourceDigest = createHash("sha256").update(artifactBytes).digest("hex");
          const queryProblem = input === undefined ? validatePerfettoQuery(parsed.flags["trace-query"]) : undefined;
          if (queryProblem !== undefined) this.emitProblem(queryProblem, 2, context);
          const storedTrace = input === undefined ? await storeValidatedArtifact() : undefined;
          const trace =
            storedTrace === undefined
              ? importPerfettoSummary(input, {sourceArtifact, sourceDigest})
              : await importPerfettoTrace({
                  sourceArtifact,
                  sourceDigest,
                  tracePath: storedTrace.path,
                  query: parsed.flags["trace-query"],
                });
          if ("code" in trace)
            this.emitProblem(
              trace,
              trace.code === "trace-processor-unavailable" || trace.code === "trace-processor-timeout" ? 3 : 2,
              context,
            );
          if (storedTrace === undefined) await storeValidatedArtifact();
          await printResult(trace, `Imported Perfetto summary: ${trace.rows.length} rows`, context);
          await recordReportedArtifact(context, parsed.flags.investigation, sourceArtifact, "trace");
        }
        return;
      }
      const scanReport = parseScanReport(input);
      const parsedReport =
        "_tag" in scanReport && isSarifDocument(input)
          ? importSarif(input, context.config.cwd, context.config.digest, artifactReference)
          : scanReport;
      if ("_tag" in parsedReport) this.emitProblem(parsedReport, 2, context);
      await storeValidatedArtifact();
      const rendered = renderScanReport(parsedReport, context.config.format);
      await writeResult(rendered, context);
      if (shouldPrint(context.config.format, context.config.quiet)) this.emit(rendered, context);
      await recordReportedArtifact(context, parsed.flags.investigation, artifactReference, "static");
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "smokinggun.problem.v1",
            code: "cancelled",
            message: "The report operation was cancelled.",
            recovery: "Rerun the report command when the artifact is available.",
          },
          130,
          context,
        );
      const message = cause instanceof Error ? cause.message : "The artifact could not be read.";
      this.emitProblem(
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "artifact-read-failed",
          message,
          recovery: "Pass a JSON ScanReportV2 artifact path.",
        },
        2,
        context,
      );
    }
  }
}

function isSarifDocument(input: unknown): boolean {
  const value = z.record(z.string(), z.unknown()).safeParse(input);
  return value.success && value.data.version === "2.1.0" && Array.isArray(value.data.runs);
}

function looksLikeJson(input: string): boolean {
  const trimmed = input.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function isBenchmarkTool(value: string): value is BenchmarkTool {
  return ["hyperfine", "pyperf", "google-benchmark", "criterion", "jmh"].includes(value);
}

async function recordReportedArtifact(
  context: RuntimeContext,
  investigationId: string | undefined,
  artifact: string,
  kind: "static" | "benchmark" | "profile" | "trace",
): Promise<void> {
  if (investigationId === undefined) return;
  const stored = await loadLatestInvestigation(context.artifacts, investigationId);
  if (stored === undefined) return;
  if (!canAttachReport(stored.bundle)) throw new Error(`Investigation ${investigationId} cannot accept reports.`);
  const claimClass =
    kind === "benchmark"
      ? ("constant-factor" as const)
      : kind === "profile" || kind === "trace"
        ? ("system-bottleneck" as const)
        : ("static-fact" as const);
  const next = {
    ...stored.bundle,
    state: "reported" as const,
    reports: appendInvestigationReport(stored.bundle.reports, artifact),
    evidence: appendInvestigationEvidence(stored.bundle.evidence, {
      schemaVersion: "smokinggun.evidence.v2" as const,
      id: `${investigationId}:report:${artifact}`,
      kind,
      claimClass,
      summary: `Rendered ${kind} artifact`,
      artifact,
    }),
  };
  await recordParsedInvestigationSnapshot(context.artifacts, next, stored.digest);
}
