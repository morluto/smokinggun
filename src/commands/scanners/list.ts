import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../../cli/base-command.js";
import {printResult} from "../../cli/command-output.js";
import {listScanners} from "../../scanners/registry.js";
import {loadExternalAdapters} from "../../scanners/external.js";
import {Flags} from "@oclif/core";

export default class ScannersList extends BaseCommand {
  static override description = "List built-in and optional scanner capabilities.";
  static override flags = {
    ...globalFlags,
    "allow-adapter-execution": Flags.boolean({
      description: "Authorize capability probes for configured external adapters.",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const parsed = await this.parse(ScannersList);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    const external = await loadExternalAdapters(
      context.config.adapters,
      context.config.cwd,
      context.signal,
      parsed.flags["allow-adapter-execution"],
    );
    const scanners = listScanners(external.descriptors);
    const human = [
      "Scanner capabilities",
      ...scanners.map(
        (scanner) =>
          `- ${scanner.id} ${scanner.version}: ${scanner.availability}${scanner.availability === "available" ? "" : ` (${scanner.reason})`}`,
      ),
    ].join("\n");
    await printResult(
      {schemaVersion: "footgun.scanners.v1", scanners, diagnostics: external.diagnostics},
      human,
      context,
    );
  }
}
