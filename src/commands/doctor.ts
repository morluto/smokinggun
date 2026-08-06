import {readFile} from "node:fs/promises";
import {Flags} from "@oclif/core";
import {execa} from "execa";
import {z} from "zod";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../cli/base-command.js";
import {printResult} from "../cli/command-output.js";
import {probeTreeSitter} from "../parsers/tree-sitter-runtime.js";
import {probeIsolation} from "../execution/capabilities.js";

export default class Doctor extends BaseCommand {
  static override description = "Report local Footgun capabilities and configuration health.";
  static override flags = {
    ...globalFlags,
    "check-updates": Flags.boolean({description: "Perform an explicit bounded npm registry check.", default: false}),
    "probe-isolation": Flags.boolean({description: "Probe optional local isolation executables.", default: false}),
  };

  public async run(): Promise<void> {
    const parsed = await this.parse(Doctor);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    const lock = await readFile(new URL("../../grammar.lock.json", import.meta.url), "utf8").catch(() => "{}");
    const treeSitter = await probeTreeSitter();
    const registry = parsed.flags["check-updates"]
      ? await checkRegistry(context.config.cwd, context.signal)
      : {state: "not-requested" as const};
    const isolation = parsed.flags["probe-isolation"] ? await probeIsolation(context.signal) : [];
    const scanners = context.scannerRegistry();
    const hostControls = {
      processTree: {
        status: "best-effort",
        mechanism: "execa cleanup and forceKillAfterDelay",
        limitation:
          process.platform === "win32"
            ? "Windows job-object accounting is not asserted by the host runner."
            : "Child-process cleanup is delegated to the host runner.",
      },
      filesystemIsolation: process.platform === "linux" ? "optional-namespace-runners" : "unavailable-in-core",
      networkIsolation: process.platform === "linux" ? "bwrap-nsjail-or-container" : "unavailable-in-core",
      platform: process.platform,
    };
    const result = {
      schemaVersion: "footgun.doctor.v1",
      version: "1.0.0",
      node: process.versions.node,
      platform: process.platform,
      cwd: context.config.cwd,
      configSource: context.config.source,
      network: registry,
      grammarLockPresent: lock.length > 2,
      treeSitter,
      isolation,
      hostControls,
      scanners,
    };
    const isolationSummary =
      isolation.length === 0
        ? "not requested"
        : isolation.map((entry) => `${entry.backend}: ${entry.available ? "available" : entry.reason}`).join(", ");
    const scannerSummary = scanners.map((scanner) => `${scanner.id}: ${scanner.availability}`).join(", ");
    const human = [
      `Footgun 1.0.0`,
      `Node ${result.node} on ${result.platform}`,
      `Configuration: ${result.configSource}`,
      `Network checks: ${registry.state}`,
      `Scanners: ${scannerSummary}`,
      `Tree-sitter runtime: ${treeSitter.runtime}; grammars: ${treeSitter.grammars} (${treeSitter.languages.length} loaded)`,
      `Isolation probes: ${isolationSummary}`,
    ].join("\n");
    await printResult(result, human, context);
  }
}

const registryResult = z.union([
  z.string(),
  z.strictObject({version: z.string().optional(), dist: z.strictObject({integrity: z.string().optional()}).optional()}),
]);

async function checkRegistry(
  cwd: string,
  signal: AbortSignal,
): Promise<{readonly state: "available" | "unavailable"; readonly version?: string; readonly integrity?: string}> {
  try {
    const result = await execa("npm", ["view", "footgun", "version", "dist.integrity", "--json"], {
      cwd,
      reject: false,
      stdin: "ignore",
      ...(signal === undefined ? {} : {cancelSignal: signal}),
      timeout: 5_000,
    });
    if (result.exitCode !== 0 || typeof result.stdout !== "string") return {state: "unavailable"};
    const raw: unknown = JSON.parse(result.stdout);
    const parsed = registryResult.safeParse(raw);
    if (!parsed.success) return {state: "unavailable"};
    if (typeof parsed.data === "string") return {state: "available", version: parsed.data};
    return {
      state: "available",
      ...(parsed.data.version === undefined ? {} : {version: parsed.data.version}),
      ...(parsed.data.dist?.integrity === undefined ? {} : {integrity: parsed.data.dist.integrity}),
    };
  } catch {
    return {state: "unavailable"};
  }
}
