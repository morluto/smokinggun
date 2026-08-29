import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags} from "../cli/base-command.js";
import {renderScanReport} from "../reports/render.js";
import {scanRepository} from "../scan/repository.js";
import {shouldPrint, writeResult} from "../cli/output.js";
import {resolveConfiguredPath} from "../config.js";
import {parseScannerSelection, parseScanScope} from "../scan/selection.js";

export default class Scan extends BaseCommand {
  static override description = "Scan a local repository for complexity candidates.";
  static override flags = {
    ...globalFlags,
    scanner: Flags.string({description: "Scanner IDs or auto; repeat for multiple backends.", multiple: true}),
    only: Flags.string({
      description: "Restrict analysis to language:<name>, extension, or path filters.",
      multiple: true,
    }),
  };
  static override args = {path: Args.string({description: "Repository or directory to scan.", default: "."})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Scan);
    const context = await this.context(parsed.flags);
    try {
      const target = resolveConfiguredPath(context.config.cwd, parsed.args.path);
      const scanner = parseOptionalStringArrayFlag(parsed.flags.scanner, "scanner");
      const only = parseOptionalStringArrayFlag(parsed.flags.only, "only");
      const selection = parseScannerSelection(scanner);
      if ("schemaVersion" in selection) this.emitProblem(selection, 2, context);
      const scope = parseScanScope(only);
      if ("schemaVersion" in scope) this.emitProblem(scope, 2, context);
      const {report, policyFindings} = await scanRepository(target, {
        configDigest: context.config.digest,
        selection,
        scope,
        excludes: context.config.exclude,
        profile: context.config.sourceProfile,
        maxFindings: context.config.maxFindings,
        signal: context.signal,
      });
      const rendered = renderScanReport(report, context.config.format);
      await writeResult(rendered, context);
      if (shouldPrint(context.config.format, context.config.quiet)) this.emit(rendered, context);
      if (
        context.config.strict &&
        (report.coverage.some((record) => record.parseStatus !== "complete") ||
          report.diagnostics.some((diagnostic) => diagnostic.code === "scan-scope-unmatched"))
      ) {
        if (context.config.format === "human")
          this.emitProblem(
            {
              schemaVersion: "smokinggun.problem.v1",
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
      if (failOn !== undefined && policyFindings.some((finding) => matchesFailPolicy(finding, failOn))) this.exit(4);
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "smokinggun.problem.v1",
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
          schemaVersion: "smokinggun.problem.v1",
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

function parseOptionalStringArrayFlag(input: unknown, name: string): ReadonlyArray<string> | undefined {
  if (input === undefined) return undefined;
  if (Array.isArray(input) && input.every((value): value is string => typeof value === "string")) return input;
  throw new Error(`The ${name} flag was not parsed as a string array.`);
}

function matchesFailPolicy(finding: {readonly ruleId: string; readonly severity: string}, policy: string): boolean {
  if (policy === "finding") return true;
  return finding.ruleId === policy || finding.severity === policy;
}
