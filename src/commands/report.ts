import {readFile, stat} from "node:fs/promises";
import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {renderScanReport} from "../reports/render.js";
import {parseScanReport} from "../protocol/index.js";
import {writeResult, shouldPrint} from "../cli/output.js";
import {importSarif} from "../adapters/sarif.js";
import {importBenchmark, type BenchmarkTool} from "../adapters/benchmarks.js";
import {importPerfettoSummary, importPerfettoTrace, importPprof} from "../adapters/profiles.js";
import {printResult} from "../cli/command-output.js";
import {createHash} from "node:crypto";
import type {RuntimeContext} from "../cli/context.js";
import {loadLatestInvestigation, recordInvestigationSnapshot} from "../investigations/store.js";
import {comparePortable} from "../paths.js";
import {resolve} from "node:path";
import {z} from "zod";

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
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    try {
      if (parsed.flags.benchmark !== undefined && parsed.flags.profile !== undefined)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "report-input-kind-conflict",
            message: "Choose one external artifact kind for report.",
            recovery: "Pass either --benchmark or --profile, not both.",
          },
          2,
          context,
        );
      const artifactBytes = await readBoundedArtifact(parsed.args.artifact);
      const raw = artifactBytes.toString("utf8");
      const storedArtifact = await context.artifactStore.put(parsed.args.artifact);
      const artifactReference = storedArtifact.reference;
      const input: unknown =
        parsed.flags.profile === "pprof" || (parsed.flags.profile === "perfetto" && !looksLikeJson(raw))
          ? undefined
          : JSON.parse(raw);
      if (parsed.flags.benchmark !== undefined) {
        const tool = parsed.flags.benchmark;
        if (!isBenchmarkTool(tool))
          this.emitProblem(
            {
              schemaVersion: "footgun.problem.v1",
              code: "invalid-benchmark-tool",
              message: "The benchmark tool is not supported by this Footgun build.",
              recovery: "Choose hyperfine, pyperf, google-benchmark, criterion, or jmh.",
            },
            2,
            context,
          );
        const benchmark = importBenchmark(input, {
          tool,
          rawArtifact: artifactReference,
          rawArtifactDigest: storedArtifact.digest,
        });
        if ("code" in benchmark) this.emitProblem(benchmark, 2, context);
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
          await printResult(
            profile,
            `Imported pprof profile: ${profile.sampleCount} samples, ${profile.topFunctions.length} top functions`,
            context,
          );
          await recordReportedArtifact(context, parsed.flags.investigation, sourceArtifact, "profile");
        } else {
          const sourceDigest = createHash("sha256").update(artifactBytes).digest("hex");
          const trace =
            input === undefined
              ? await importPerfettoTrace({
                  sourceArtifact,
                  sourceDigest,
                  tracePath: resolve(context.config.cwd, parsed.args.artifact),
                  query: parsed.flags["trace-query"],
                })
              : importPerfettoSummary(input, {sourceArtifact, sourceDigest});
          if ("code" in trace)
            this.emitProblem(
              trace,
              trace.code === "trace-processor-unavailable" || trace.code === "trace-processor-timeout" ? 3 : 2,
              context,
            );
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
      const rendered = renderScanReport(parsedReport, context.config.format);
      await writeResult(rendered, context);
      if (shouldPrint(context.config.format, context.config.quiet)) this.emit(rendered, context);
      await recordReportedArtifact(context, parsed.flags.investigation, artifactReference, "static");
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
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
          schemaVersion: "footgun.problem.v1",
          code: "artifact-read-failed",
          message,
          recovery: "Pass a JSON ScanReportV1 artifact path.",
        },
        2,
        context,
      );
    }
  }
}

async function readBoundedArtifact(path: string, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("The report input must be a regular file.");
  if (info.size > maxBytes) throw new Error(`The report input exceeds the ${maxBytes} byte artifact limit.`);
  return readFile(path);
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
  const claimClass =
    kind === "benchmark"
      ? ("constant-factor" as const)
      : kind === "profile" || kind === "trace"
        ? ("system-bottleneck" as const)
        : ("static-fact" as const);
  const next = {
    ...stored.bundle,
    state: "reported" as const,
    reports: [...new Set([...stored.bundle.reports, artifact])].sort(comparePortable),
    evidence: [
      ...stored.bundle.evidence,
      {
        schemaVersion: "footgun.evidence.v1" as const,
        id: `${investigationId}:report:${artifact}`,
        kind,
        claimClass,
        summary: `Rendered ${kind} artifact`,
        artifact,
      },
    ],
  };
  await recordInvestigationSnapshot(context.artifacts, next);
}
