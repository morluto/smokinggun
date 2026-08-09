import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Args, Flags} from "@oclif/core";
import {ExitError} from "@oclif/core/errors";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {printResult} from "../cli/command-output.js";
import {scanRepository} from "../scan/repository.js";
import {Protocol, type InvestigationBundleV2} from "../protocol/index.js";
import {resolveConfiguredPath} from "../config.js";
import {loadLatestInvestigation, recordInvestigationSnapshot} from "../investigations/store.js";
import {stableJson} from "../serialization.js";

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
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
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
      const report = parsed.flags["plan-only"]
        ? undefined
        : await scanRepository(target, {
            configDigest: context.config.digest,
            excludes: context.config.exclude,
            maxFindings: Number.MAX_SAFE_INTEGER,
            adapterManifests: context.config.adapters,
            signal: context.signal,
          });
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
      const investigationDigest = createHash("sha256").update(stableJson({target, finding, report})).digest("hex");
      const id = `inv_${investigationDigest.slice(0, 16)}`;
      const directory = join(context.artifacts, "investigations", id);
      if (parsed.flags["plan-only"]) {
        const existing = await loadLatestInvestigation(context.artifacts, id);
        if (existing !== undefined && !["created", "inventoried"].includes(existing.bundle.state)) {
          await printResult(
            existing.bundle,
            `Investigation ${id}\nState: ${existing.bundle.state}\nBundle: ${join(directory, "snapshots", `${existing.digest}.json`)}`,
            context,
          );
          return;
        }
      }
      await mkdir(directory, {recursive: true});
      const reportPath = join(directory, "scan-report.json");
      const reportBytes =
        report === undefined ? undefined : Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
      const reportDigest =
        reportBytes === undefined ? undefined : createHash("sha256").update(reportBytes).digest("hex");
      if (reportBytes !== undefined) await writeFile(reportPath, reportBytes);
      const createdBundle: InvestigationBundleV2 = {
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
                ...(report.context === undefined ? {} : {[report.context.tool.name]: report.context.tool.version}),
              },
            }),
        createdAt: new Date().toISOString(),
        reports: [],
        evidence: [],
        diagnostics: [],
        ...(finding === undefined ? {} : {findingIds: [finding]}),
      };
      await recordInvestigationSnapshot(context.artifacts, createdBundle);
      const inventoriedBundle: InvestigationBundleV2 = {...createdBundle, state: "inventoried"};
      await recordInvestigationSnapshot(context.artifacts, inventoriedBundle);
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
          : {...scannedBundle, state: "context-resolved"};
      const parsedBundle = Protocol.investigation.safeParse(bundle);
      if (!parsedBundle.success) throw new Error("Internal investigation bundle validation failed.");
      const finalBundle = parsedBundle.data;
      const bundlePath = join(directory, "bundle.json");
      await writeFile(bundlePath, `${JSON.stringify(finalBundle, null, 2)}\n`, "utf8");
      await recordInvestigationSnapshot(context.artifacts, scannedBundle);
      if (finalBundle.state !== scannedBundle.state) await recordInvestigationSnapshot(context.artifacts, finalBundle);
      await printResult(
        finalBundle,
        `Investigation ${id}\nState: ${finalBundle.state}\nBundle: ${bundlePath}`,
        context,
      );
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
