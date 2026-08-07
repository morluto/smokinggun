import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {renderScanReport} from "../reports/render.js";
import {scanRepository} from "../scan/repository.js";
import {shouldPrint, writeResult} from "../cli/output.js";
import {resolveConfiguredPath} from "../config.js";

export default class Scan extends BaseCommand {
  static override description = "Scan a local repository for complexity candidates.";
  static override flags = {
    ...globalFlags,
    scanner: Flags.string({description: "Scanner IDs or auto; repeat for multiple backends.", multiple: true}),
    only: Flags.string({
      description: "Restrict analysis to language:<name>, extension, or path filters.",
      multiple: true,
    }),
    adapter: Flags.string({
      description: "External adapter manifest path; repeat to configure adapters.",
      multiple: true,
    }),
    "allow-adapter-execution": Flags.boolean({
      description: "Authorize execution of explicitly configured external adapters.",
      default: false,
    }),
  };
  static override args = {path: Args.string({description: "Repository or directory to scan.", default: "."})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Scan);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    try {
      const target = resolveConfiguredPath(context.config.cwd, parsed.args.path);
      const scanner = parsed.flags.scanner as ReadonlyArray<string> | undefined;
      const only = parsed.flags.only as ReadonlyArray<string> | undefined;
      const adapter = parsed.flags.adapter as ReadonlyArray<string> | undefined;
      const report = await scanRepository(target, {
        configDigest: context.config.digest,
        excludes: context.config.exclude,
        maxFindings: context.config.maxFindings,
        signal: context.signal,
        ...(scanner === undefined ? {} : {scanners: scanner}),
        ...(only === undefined ? {} : {only}),
        adapterManifests: [...context.config.adapters, ...(adapter ?? [])],
        allowAdapterExecution: parsed.flags["allow-adapter-execution"],
      });
      const rendered = renderScanReport(report, context.config.format);
      await writeResult(rendered, context);
      if (shouldPrint(context.config.format, context.config.quiet)) this.emit(rendered, context);
      if (context.config.strict && report.coverage.some((record) => record.parseStatus !== "complete")) {
        if (context.config.format === "human")
          this.emitProblem(
            {
              schemaVersion: "footgun.problem.v1",
              code: "incomplete-coverage",
              message: "The scan completed with incomplete coverage.",
              recovery: "Inspect diagnostics or rerun without --strict.",
            },
            3,
            context,
          );
        this.exit(3);
      }
      const failOn = context.config.failOn;
      if (failOn !== undefined && report.findings.some((finding) => matchesFailPolicy(finding, failOn))) this.exit(4);
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "cancelled",
            message: "The scan was cancelled.",
            recovery: "Rerun the scan when the repository is available.",
          },
          130,
          context,
        );
      const message = cause instanceof Error ? cause.message : "The scan failed unexpectedly.";
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "scan-failed",
          message,
          recovery: "Run with --debug for diagnostics.",
        },
        1,
        context,
      );
    }
  }
}

function matchesFailPolicy(finding: {readonly ruleId: string; readonly severity: string}, policy: string): boolean {
  if (policy === "finding") return true;
  return finding.ruleId === policy || finding.severity === policy;
}
