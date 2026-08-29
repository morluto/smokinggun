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
import {encodeScanArtifact} from "../reports/scan-artifact.js";

export default class Investigate extends BaseCommand {
  static override description = "Create a durable local investigation bundle from a scan.";
  static override flags = {
    ...globalFlags,
    finding: Flags.string({description: "Focus on one stable finding ID."}),
    "plan-only": Flags.boolean({
      description: "Create a plan for measurement evidence produced by an external benchmark tool.",
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
      if (finding !== undefined && !/^sg_[a-f0-9]{16}$/.test(finding))
        this.emitProblem(
          {
            schemaVersion: "smokinggun.problem.v1",
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
            profile: context.config.sourceProfile,
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
              schemaVersion: "smokinggun.problem.v1",
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
              schemaVersion: "smokinggun.problem.v1",
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
      const encodedReport = report === undefined ? undefined : encodeScanArtifact(report);
      const storedReport =
        encodedReport === undefined
          ? undefined
          : await context.artifactStore.putBytes("scan-report.json", encodedReport.bytes);
      if (encodedReport !== undefined && storedReport?.digest !== encodedReport.digest)
        throw new Error("The retained scan report does not match its canonical content digest.");
      const createdBundle: InvestigationBundleV2 =
        existing?.bundle.state === "created"
          ? existing.bundle
          : {
              schemaVersion: "smokinggun.investigation-bundle.v2",
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
                      smokinggun: report.tool.version,
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
      const createdDigest =
        existing !== undefined
          ? existing.digest
          : await recordParsedInvestigationSnapshot(context.artifacts, createdBundle, null);
      const inventoriedBundle: InvestigationBundleV2 =
        existing?.bundle.state === "inventoried" ? existing.bundle : {...createdBundle, state: "inventoried"};
      const inventoriedDigest =
        existing?.bundle.state === "inventoried"
          ? existing.digest
          : await recordParsedInvestigationSnapshot(context.artifacts, inventoriedBundle, createdDigest);
      let scannedBundle: InvestigationBundleV2;
      let bundle: InvestigationBundleV2;
      if (report === undefined) {
        scannedBundle = {...inventoriedBundle, state: "measurement-planned"};
        bundle = scannedBundle;
      } else {
        if (storedReport === undefined) throw new Error("A scanned investigation requires a retained report.");
        scannedBundle = {
          ...inventoriedBundle,
          state: "scanned",
          reports: [storedReport.reference],
          evidence: [
            {
              schemaVersion: "smokinggun.evidence.v2",
              id: `${id}:scan`,
              kind: "static",
              claimClass: "static-fact",
              summary: "Built-in structural scan",
              artifact: storedReport.reference,
              digest: storedReport.digest,
            },
          ],
          diagnostics: report.diagnostics,
        };
        bundle =
          report.context === undefined
            ? scannedBundle
            : {
                ...scannedBundle,
                state: "context-resolved",
                evidence: [
                  ...scannedBundle.evidence,
                  {
                    schemaVersion: "smokinggun.evidence.v2",
                    id: `${id}:context:scan`,
                    kind: "context",
                    claimClass: "static-fact",
                    summary: "Compiler-backed repository context from the scan report",
                    artifact: storedReport.reference,
                    digest: storedReport.digest,
                  },
                ],
              };
      }
      const scannedDigest = await recordParsedInvestigationSnapshot(
        context.artifacts,
        scannedBundle,
        inventoriedDigest,
      );
      const bundleDigest =
        bundle.state === scannedBundle.state
          ? scannedDigest
          : await recordParsedInvestigationSnapshot(context.artifacts, bundle, scannedDigest);
      const bundlePath = join(directory, "snapshots", `${bundleDigest}.json`);
      await printResult(bundle, `Investigation ${id}\nState: ${bundle.state}\nBundle: ${bundlePath}`, context);
    } catch (cause: unknown) {
      if (cause instanceof ExitError) throw cause;
      if (context.signal.aborted)
        this.emitProblem(
          {
            schemaVersion: "smokinggun.problem.v1",
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
          schemaVersion: "smokinggun.problem.v1",
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
