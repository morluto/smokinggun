import {BaseCommand, globalFlags} from "../../cli/base-command.js";
import {printResult} from "../../cli/command-output.js";
import {listScanners} from "../../scanners/registry.js";

export default class ScannersList extends BaseCommand {
  static override description = "List built-in scanner capabilities.";
  static override flags = globalFlags;

  public async run(): Promise<void> {
    const parsed = await this.parse(ScannersList);
    const context = await this.context(parsed.flags);
    const scanners = listScanners();
    const human = [
      "Scanner capabilities",
      ...scanners.map(
        (scanner) =>
          `- ${scanner.id} ${scanner.version}: ${scanner.availability}${scanner.availability === "available" ? "" : ` (${scanner.reason})`}`,
      ),
    ].join("\n");
    await printResult({schemaVersion: "smokinggun.scanners.v1", scanners, diagnostics: []}, human, context);
  }
}
