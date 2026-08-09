import {Args, Flags} from "@oclif/core";
import {createHash} from "node:crypto";
import {join} from "node:path";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../../cli/base-command.js";
import {printResult} from "../../cli/command-output.js";
import {importScip} from "../../context/scip.js";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  canRecordContext,
  loadLatestInvestigation,
  recordParsedInvestigationSnapshot,
} from "../../investigations/store.js";
import {writeFileAtomically} from "../../files.js";

export default class ContextImport extends BaseCommand {
  static override description = "Import a SCIP semantic index as local repository context.";
  static override flags = {
    ...globalFlags,
    investigation: Flags.string({description: "Attach imported context to an existing investigation bundle."}),
  };
  static override args = {artifact: Args.string({required: true, description: "Path to a SCIP protobuf index."})};

  public async run(): Promise<void> {
    const parsed = await this.parse(ContextImport);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    const result = await importScip(parsed.args.artifact, context.config.cwd);
    const index = result.state === "unavailable" ? undefined : result.index;
    const value = {
      schemaVersion: "footgun.context-import.v1",
      state: result.state,
      ...(index === undefined ? {} : {index}),
      diagnostics: result.diagnostics,
    };
    const investigation =
      parsed.flags.investigation === undefined || index === undefined
        ? undefined
        : await loadLatestInvestigation(context.artifacts, parsed.flags.investigation);
    if (
      parsed.flags.investigation !== undefined &&
      investigation !== undefined &&
      !canRecordContext(investigation.bundle)
    )
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "investigation-not-context-ready",
          message: `Investigation ${parsed.flags.investigation} is in ${investigation.bundle.state} state and cannot retain imported context.`,
          recovery: "Investigate the target until it reaches scanned, context-resolved, or measurement-planned state.",
        },
        1,
        context,
      );
    const human = [
      `SCIP import: ${result.state}`,
      index === undefined
        ? "No semantic index was produced."
        : `Files indexed: ${index.coverage.filesIndexed}/${index.coverage.filesDiscovered}`,
      `Definitions: ${index?.definitions.length ?? 0}`,
      `References: ${index?.references.length ?? 0}`,
      ...(result.diagnostics.length === 0 ? [] : [`Diagnostics: ${result.diagnostics.length}`]),
    ].join("\n");
    await printResult(value, human, context);
    if (parsed.flags.investigation !== undefined && index !== undefined && investigation !== undefined) {
      const artifactBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
      const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");
      const artifact = `context-${artifactDigest.slice(0, 16)}.json`;
      const directory = join(context.artifacts, "investigations", parsed.flags.investigation);
      await writeFileAtomically(join(directory, artifact), artifactBytes);
      await recordParsedInvestigationSnapshot(context.artifacts, {
        ...investigation.bundle,
        state: "context-resolved",
        reports: appendInvestigationReport(investigation.bundle.reports, artifact),
        evidence: appendInvestigationEvidence(investigation.bundle.evidence, {
          schemaVersion: "footgun.evidence.v2",
          id: `${parsed.flags.investigation}:context:${index.digest.slice(0, 16)}`,
          kind: "context",
          claimClass: "static-fact",
          summary: "Imported SCIP repository context",
          artifact,
          digest: artifactDigest,
        }),
      });
    }
    if (result.state === "unavailable") this.exit(3);
  }
}
