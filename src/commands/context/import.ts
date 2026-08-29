import {Args, Flags} from "@oclif/core";
import {BaseCommand, globalFlags} from "../../cli/base-command.js";
import {printResult} from "../../cli/command-output.js";
import {importScip} from "../../context/scip.js";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  canRecordContext,
  loadLatestInvestigation,
  recordParsedInvestigationSnapshot,
} from "../../investigations/store.js";
import {stableJson} from "../../serialization.js";

export default class ContextImport extends BaseCommand {
  static override description = "Import a SCIP semantic index as local repository context.";
  static override flags = {
    ...globalFlags,
    investigation: Flags.string({description: "Attach imported context to an existing investigation bundle."}),
  };
  static override args = {artifact: Args.string({required: true, description: "Path to a SCIP protobuf index."})};

  public async run(): Promise<void> {
    const parsed = await this.parse(ContextImport);
    const context = await this.context(parsed.flags);
    const investigation =
      parsed.flags.investigation === undefined
        ? undefined
        : await loadLatestInvestigation(context.artifacts, parsed.flags.investigation);
    if (parsed.flags.investigation !== undefined && investigation === undefined)
      this.emitProblem(
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "investigation-unavailable",
          message: "The requested investigation does not exist.",
          recovery: "Create or select an existing investigation before importing context.",
        },
        2,
        context,
      );
    if (investigation !== undefined && !canRecordContext(investigation.bundle))
      this.emitProblem(
        {
          schemaVersion: "smokinggun.problem.v1",
          code: "investigation-not-context-ready",
          message: `Investigation ${parsed.flags.investigation} is in ${investigation.bundle.state} state and cannot retain imported context.`,
          recovery: "Investigate the target until it reaches scanned, context-resolved, or measurement-planned state.",
        },
        1,
        context,
      );
    const result = await importScip(parsed.args.artifact, context.config.cwd);
    const index = result.state === "unavailable" ? undefined : result.index;
    const value = {
      schemaVersion: "smokinggun.context-import.v1",
      state: result.state,
      ...(index === undefined ? {} : {index}),
      diagnostics: result.diagnostics,
    };
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
      const artifactBytes = Buffer.from(`${stableJson(index)}\n`, "utf8");
      const storedArtifact = await context.artifactStore.putBytes("context.json", artifactBytes);
      await recordParsedInvestigationSnapshot(
        context.artifacts,
        {
          ...investigation.bundle,
          state: "context-resolved",
          reports: appendInvestigationReport(investigation.bundle.reports, storedArtifact.reference),
          evidence: appendInvestigationEvidence(investigation.bundle.evidence, {
            schemaVersion: "smokinggun.evidence.v2",
            id: `${parsed.flags.investigation}:context:${index.digest.slice(0, 16)}`,
            kind: "context",
            claimClass: "static-fact",
            summary: "Imported SCIP repository context",
            artifact: storedArtifact.reference,
            digest: storedArtifact.digest,
          }),
        },
        investigation.digest,
      );
    }
    if (result.state === "unavailable") this.exit(3);
  }
}
