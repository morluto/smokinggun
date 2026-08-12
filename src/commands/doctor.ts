import {readFile} from "node:fs/promises";
import {Flags} from "@oclif/core";
import {execa} from "execa";
import {z} from "zod";
import {BaseCommand, globalFlags} from "../cli/base-command.js";
import {printResult} from "../cli/command-output.js";
import {probeTreeSitter} from "../parsers/tree-sitter-runtime.js";
import {toolIdentity} from "../tool-identity.js";
import {adapterExecutionNotAuthorized, loadExternalAdapters} from "../scanners/external.js";
import {listScanners} from "../scanners/registry.js";

export default class Doctor extends BaseCommand {
  static override description = "Report local SmokingGun capabilities and configuration health.";
  static override flags = {
    ...globalFlags,
    "check-updates": Flags.boolean({description: "Perform an explicit bounded npm registry check.", default: false}),
  };

  public async run(): Promise<void> {
    const parsed = await this.parse(Doctor);
    const context = await this.context(parsed.flags);
    const lock = await readFile(new URL("../../grammar.lock.json", import.meta.url), "utf8").catch(() => "{}");
    const treeSitter = await probeTreeSitter();
    const registry = parsed.flags["check-updates"]
      ? await checkRegistry(context.config.cwd, context.signal)
      : {state: "not-requested" as const};
    const external = await loadExternalAdapters(context.config.adapters, context.config.cwd, {
      signal: context.signal,
      authorization: adapterExecutionNotAuthorized,
    });
    const scanners = listScanners(external.descriptors);
    const result = {
      schemaVersion: "smokinggun.doctor.v1",
      version: toolIdentity.version,
      node: process.versions.node,
      platform: process.platform,
      cwd: context.config.cwd,
      configSource: context.config.source,
      network: registry,
      grammarLockPresent: lock.length > 2,
      treeSitter,
      scanners,
    };
    const scannerSummary = scanners.map((scanner) => `${scanner.id}: ${scanner.availability}`).join(", ");
    const human = [
      `SmokingGun ${toolIdentity.version}`,
      `Node ${result.node} on ${result.platform}`,
      `Configuration: ${result.configSource}`,
      `Network checks: ${registry.state}`,
      `Scanners: ${scannerSummary}`,
      `Tree-sitter runtime: ${treeSitter.runtime}; grammars: ${treeSitter.grammars} (${treeSitter.languages.length} loaded)`,
    ].join("\n");
    await printResult(result, human, context);
  }
}

const registryResult = z.union([
  z.string(),
  z.strictObject({version: z.string().optional(), dist: z.strictObject({integrity: z.string().optional()}).optional()}),
]);

type RegistryCheck =
  | {readonly state: "not-requested"}
  | {readonly state: "available"; readonly version?: string; readonly integrity?: string}
  | {readonly state: "unavailable"};

async function checkRegistry(cwd: string, signal: AbortSignal): Promise<RegistryCheck> {
  try {
    const result = await execa("npm", ["view", "smokinggun", "version", "dist.integrity", "--json"], {
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
