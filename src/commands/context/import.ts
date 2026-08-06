import {Args, Flags} from "@oclif/core";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../../cli/base-command.js";
import {printResult} from "../../cli/command-output.js";
import {importScip} from "../../context/scip.js";
import {loadLatestInvestigation, recordInvestigationSnapshot} from "../../investigations/store.js";
import {comparePortable} from "../../paths.js";

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
    const value = {
      schemaVersion: "footgun.context-import.v1",
      state: result.state,
      ...(result.index === undefined ? {} : {index: result.index}),
      diagnostics: result.diagnostics,
    };
    const human = [
      `SCIP import: ${result.state}`,
      result.index === undefined
        ? "No semantic index was produced."
        : `Files indexed: ${result.index.coverage.filesIndexed}/${result.index.coverage.filesDiscovered}`,
      `Definitions: ${result.index?.definitions.length ?? 0}`,
      `References: ${result.index?.references.length ?? 0}`,
      ...(result.diagnostics.length === 0 ? [] : [`Diagnostics: ${result.diagnostics.length}`]),
    ].join("\n");
    await printResult(value, human, context);
    if (parsed.flags.investigation !== undefined && result.index !== undefined) {
      const stored = await loadLatestInvestigation(context.artifacts, parsed.flags.investigation);
      if (stored !== undefined) {
        const artifact = `context-${result.index.digest.slice(0, 16)}.json`;
        const directory = join(context.artifacts, "investigations", parsed.flags.investigation);
        await mkdir(directory, {recursive: true});
        await writeFile(join(directory, artifact), `${JSON.stringify(result.index, null, 2)}\n`, "utf8");
        await recordInvestigationSnapshot(context.artifacts, {
          ...stored.bundle,
          state: "context-resolved",
          reports: [...new Set([...stored.bundle.reports, artifact])].sort(comparePortable),
          evidence: [
            ...stored.bundle.evidence,
            {
              schemaVersion: "footgun.evidence.v1",
              id: `${parsed.flags.investigation}:context:${result.index.digest.slice(0, 16)}`,
              kind: "context",
              claimClass: "static-fact",
              summary: "Imported SCIP repository context",
              artifact,
              digest: result.index.digest,
            },
          ],
        });
      }
    }
    if (result.state === "unavailable") this.exit(3);
  }
}
