import {createHash} from "node:crypto";
import {join} from "node:path";
import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags} from "../cli/base-command.js";
import {printResult} from "../cli/command-output.js";
import {scanRepository} from "../scan/repository.js";
import type {InvestigationBundleV2, ScanReportV2} from "../protocol/index.js";
import {resolveConfiguredPath} from "../config.js";
import {loadLatestInvestigation, recordParsedInvestigationSnapshot} from "../investigations/store.js";
import {stableJson} from "../serialization.js";
import {automaticScannerSelection, entireScanRoot} from "../scan/selection.js";
import {adapterExecutionNotAuthorized, parseExternalAdapters} from "../scanners/external.js";
import {writeFileAtomically} from "../files.js";

export default class Investigate extends BaseCommand {
  static override description = "Create a durable local investigation bundle from a scan.";
  static override flags = {
    ...globalFlags,
    finding: Flags.string({description: "Focus on one stable finding ID."}),
    "plan-only": Flags.boolean({
      description: "Create a measurement-planning bundle without executing workloads.",
      default: false,
    }),
  };
  static override args = {path: Args.string({description: "Repository or directory to investigate.", default: "."})};

  public async run(): Promise<void> {
    const parsed = await this.parse(Investigate);
    const context = await this.context(parsed.flags);
    try {
      const target = resolveConfiguredPath(context.config.cwd, parsed.args.path);
      const finding = parsed.flags.finding;
      if (finding !== undefined && !/^fg_[a-f0-9]{16}$/.test(finding))
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "invalid-finding-id",
            message: "The investigation finding ID is not a stable SmokingGun finding ID.",
            recovery: "Pass an ID returned by `smokinggun scan <path> --format json`.",
          },
          2,
          context,
        );
      let report: ScanReportV2 | undefined;
      if (!parsed.flags["plan-only"]) {
        const adapters = await parseExternalAdapters(context.config.adapters, context.config.cwd, context.signal);
        report = (
          await scanRepository(target, {
            configDigest: context.config.digest,
            selection: automaticScannerSelection(),
            scope: entireScanRoot(),
            excludes: context.config.exclude,
            maxFindings: Number.MAX_SAFE_INTEGER,
            adapters,
            adapterAuthorization: adapterExecutionNotAuthorized,
            signal: context.signal,
          })
        ).report;
      }
      if (finding !== undefined) {
        if (report === undefined)
          this.emitProblem(
            {
              schemaVersion: "footgun.problem.v1",
              code: "finding-validation-required",
              message: "A focused investigation requires a scan that can validate the finding ID.",
              recovery: "Rerun without --plan-only or omit --finding.",
            },
            2,
            context,
          );
        if (!report.findings.some((candidate) => candidate.id === finding))
          this.emitProblem(
            {
              schemaVersion: "footgun.problem.v1",
              code: "finding-not-found",
              message: "The requested finding ID is not present in this scan report.",
              recovery: "Pass a finding ID from this repository's current scan output.",
            },
            2,
            context,
          );
      }
      const investigationDigest = createHash("sha256")
        .update(
          stableJson(
            report === undefined
              ? {target, finding, mode: "plan-only"}
              : {
                  target,
                  finding,
                  mode: "scan",
                  sourceDigest: report.sourceDigest ?? null,
                  configDigest: report.configDigest,
                },
          ),
        )
        .digest("hex");
      const id = `inv_${investigationDigest.slice(0, 16)}`;
      const directory = join(context.artifacts, "investigations", id);
      const existing = await loadLatestInvestigation(context.artifacts, id);
      if (existing !== undefined && !["created", "inventoried"].includes(existing.bundle.state)) {
        await printResult(
          existing.bundle,
          `Investigation ${id}\nState: ${existing.bundle.state}\nBundle: ${join(directory, "snapshots", `${existing.digest}.json`)}`,
          context,
        );
        return;
      }
      const reportPath = join(directory, "scan-report.json");
      const reportBytes =
        report === undefined ? undefined : Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      const reportDigest =
        reportBytes === undefined ? undefined : createHash("sha256").update(reportBytes).digest("hex");
      if (reportBytes !== undefined) await writeFileAtomically(reportPath, reportBytes);
      const createdBundle: InvestigationBundleV2 =
        existing?.bundle.state === "created"
          ? existing.bundle
          : {
              schemaVersion: "footgun.investigation-bundle.v2",
              id,
              state: "created",
              root: report?.repository.root ?? ".",
              ...(report === undefined
                ? {callers: [], inputs: [], tests: [], workloads: [], assumptions: [], versions: {}}
                : {
                    repository: report.repository,
                    ...(report.sourceDigest === undefined ? {} : {sourceDigest: report.sourceDigest}),
                    callers: report.context?.calls.map((call) => `${call.callee} @ ${call.path}:${call.line}`) ?? [],
                    inputs: report.inventory?.manifests ?? [],
                    tests: report.inventory?.tests ?? [],
                    workloads: report.inventory?.benchmarks ?? [],
                    assumptions: report.assumptions,
                    versions: {
                      footgun: report.tool.version,
                      ...(report.context === undefined
                        ? {}
                        : {[report.context.tool.name]: report.context.tool.version}),
                    },
                  }),
              createdAt: new Date().toISOString(),
              reports: [],
              evidence: [],
              diagnostics: [],
              ...(finding === undefined ? {} : {findingIds: [finding]}),
            };
      if (existing?.bundle.state !== "created")
        await recordParsedInvestigationSnapshot(context.artifacts, createdBundle);
      const inventoriedBundle: InvestigationBundleV2 =
        existing?.bundle.state === "inventoried" ? existing.bundle : {...createdBundle, state: "inventoried"};
      if (existing?.bundle.state !== "inventoried")
        await recordParsedInvestigationSnapshot(context.artifacts, inventoriedBundle);
      const scannedBundle: InvestigationBundleV2 =
        report === undefined
          ? {...inventoriedBundle, state: "measurement-planned"}
          : {
              ...inventoriedBundle,
              state: "scanned",
              reports: ["scan-report.json"],
              evidence: [
                {
                  schemaVersion: "footgun.evidence.v2",
                  id: `${id}:scan`,
                  kind: "static",
                  claimClass: "static-fact",
                  summary: "Built-in structural scan",
                  artifact: "scan-report.json",
                  digest: reportDigest,
                },
              ],
              diagnostics: report.diagnostics,
            };
      const bundle: InvestigationBundleV2 =
        report?.context === undefined || scannedBundle.state !== "scanned"
          ? scannedBundle
          : {
              ...scannedBundle,
              state: "context-resolved",
              evidence: [
                ...scannedBundle.evidence,
                {
                  schemaVersion: "footgun.evidence.v2",
                  id: `${id}:context:scan`,
                  kind: "context",
                  claimClass: "static-fact",
                  summary: "Compiler-backed repository context from the scan report",
                  artifact: "scan-report.json",
                  digest: reportDigest,
                },
              ],
            };
      const bundlePath = join(directory, "bundle.json");
      await writeFileAtomically(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
      await recordParsedInvestigationSnapshot(context.artifacts, scannedBundle);
      if (bundle.state !== scannedBundle.state) await recordParsedInvestigationSnapshot(context.artifacts, bundle);
      await printResult(bundle, `Investigation ${id}\nState: ${bundle.state}\nBundle: ${bundlePath}`, context);
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "footgun.problem.v1",
            code: "cancelled",
            message: "The investigation was cancelled.",
            recovery: "Rerun the investigation when the repository is available.",
          },
          130,
          context,
        );
      const message = cause instanceof Error ? cause.message : "Investigation failed.";
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "investigation-failed",
          message,
          recovery: "Rerun with a readable local path.",
        },
        1,
        context,
      );
    }
  }
}
