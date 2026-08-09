import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {execa} from "execa";
import {Protocol, type AdapterManifestV1, type ProblemV1} from "../protocol/index.js";
import {executionEnvironment, redactSensitive} from "../execution/environment.js";
import {comparePortable} from "../paths.js";
import type {ScannerDescriptor} from "./registry.js";

export type ExternalScannerDescriptor = ScannerDescriptor & {
  readonly kind: "adapter";
  readonly manifestPath: string;
  readonly tool?: AdapterManifestV1["tool"];
};

export type LoadedExternalAdapter = {
  readonly manifest: AdapterManifestV1;
  readonly path: string;
  readonly descriptor: ExternalScannerDescriptor;
};

type ExternalAdapterProbe =
  | {readonly available: true; readonly version?: string}
  | {readonly available: false; readonly reason: string};

export async function loadExternalAdapters(
  paths: ReadonlyArray<string>,
  root: string,
  signal?: AbortSignal,
  allowExecution = false,
): Promise<{
  readonly adapters: ReadonlyArray<LoadedExternalAdapter>;
  readonly descriptors: ReadonlyArray<ExternalScannerDescriptor>;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
}> {
  const adapters: LoadedExternalAdapter[] = [];
  const descriptors: ExternalScannerDescriptor[] = [];
  const diagnostics: ProblemV1[] = [];
  for (const inputPath of [...new Set(paths)].sort()) {
    signal?.throwIfAborted();
    const path = resolve(root, inputPath);
    let input: unknown;
    try {
      input = JSON.parse(await readFile(path, "utf8"));
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? redactSensitive(cause.message) : "The manifest could not be read.";
      diagnostics.push(
        problem("adapter-manifest-read-failed", `Could not read adapter manifest ${inputPath}.`, detail, inputPath),
      );
      descriptors.push({
        id: inputPath,
        version: "unknown",
        kind: "adapter",
        capabilities: [],
        availability: "invalid",
        manifestPath: inputPath,
        reason: detail,
      });
      continue;
    }
    const parsed = Protocol.adapterManifest.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      diagnostics.push(
        problem("invalid-adapter-manifest", `Adapter manifest ${inputPath} is invalid.`, detail, inputPath),
      );
      descriptors.push({
        id: inputPath,
        version: "unknown",
        kind: "adapter",
        capabilities: [],
        availability: "invalid",
        manifestPath: inputPath,
        reason: detail,
      });
      continue;
    }
    if (!allowExecution) {
      const reason =
        "Adapter execution requires explicit authorization; rerun with --allow-adapter-execution to probe it.";
      diagnostics.push(
        problem(
          "adapter-execution-required",
          `Adapter ${parsed.data.id} was not probed or executed.`,
          reason,
          inputPath,
        ),
      );
      const descriptor: ExternalScannerDescriptor = {
        id: parsed.data.id,
        version: parsed.data.version,
        kind: "adapter",
        capabilities: parsed.data.capabilities,
        availability: "unavailable",
        manifestPath: inputPath,
        ...(parsed.data.tool === undefined ? {} : {tool: parsed.data.tool}),
        reason,
      };
      descriptors.push(descriptor);
      adapters.push({manifest: parsed.data, path: inputPath, descriptor});
      continue;
    }
    if (parsed.data.sideEffects.includes("network")) {
      const reason = "Network-capable adapters are blocked by SmokingGun's offline static policy.";
      diagnostics.push(
        problem("adapter-network-blocked", `Adapter ${parsed.data.id} was not probed or executed.`, reason, inputPath),
      );
      descriptors.push({
        id: parsed.data.id,
        version: parsed.data.version,
        kind: "adapter",
        capabilities: parsed.data.capabilities,
        availability: "unavailable",
        manifestPath: inputPath,
        ...(parsed.data.tool === undefined ? {} : {tool: parsed.data.tool}),
        reason,
      });
      adapters.push({
        manifest: parsed.data,
        path: inputPath,
        descriptor: {
          id: parsed.data.id,
          version: parsed.data.version,
          kind: "adapter",
          capabilities: parsed.data.capabilities,
          availability: "unavailable",
          manifestPath: inputPath,
          reason,
        },
      });
      continue;
    }
    const probe = await probeExternalAdapter(parsed.data, root, signal);
    const descriptor: ExternalScannerDescriptor = probe.available
      ? {
          id: parsed.data.id,
          version: probe.version ?? parsed.data.version,
          kind: "adapter",
          capabilities: parsed.data.capabilities,
          availability: "available",
          manifestPath: inputPath,
          ...(parsed.data.tool === undefined ? {} : {tool: parsed.data.tool}),
        }
      : {
          id: parsed.data.id,
          version: parsed.data.version,
          kind: "adapter",
          capabilities: parsed.data.capabilities,
          availability: "unavailable",
          manifestPath: inputPath,
          ...(parsed.data.tool === undefined ? {} : {tool: parsed.data.tool}),
          reason: probe.reason,
        };
    descriptors.push(descriptor);
    adapters.push({manifest: parsed.data, path: inputPath, descriptor});
  }
  return {
    adapters: adapters.sort((left, right) => comparePortable(left.manifest.id, right.manifest.id)),
    descriptors: descriptors.sort((left, right) => comparePortable(left.id, right.id)),
    diagnostics,
  };
}

async function probeExternalAdapter(
  manifest: AdapterManifestV1,
  root: string,
  signal?: AbortSignal,
): Promise<ExternalAdapterProbe> {
  const command = manifest.probeCommand ?? [manifest.command[0] ?? "", "--version"];
  const executable = command[0];
  if (executable === undefined || executable === "") return {available: false, reason: "The adapter command is empty."};
  try {
    const result = await execa(executable, command.slice(1), {
      cwd: root,
      env: executionEnvironment({}, false),
      extendEnv: false,
      stdin: "ignore",
      timeout: 1_000,
      maxBuffer: 8_192,
      reject: false,
      shell: false,
      windowsHide: false,
      ...(signal === undefined ? {} : {cancelSignal: signal}),
    });
    if (result.isCanceled || signal?.aborted)
      return {available: false, reason: "Adapter capability probing was cancelled."};
    if (result.exitCode !== 0)
      return {available: false, reason: "The adapter executable did not pass its capability probe."};
    const version = result.stdout.trim().split(/\r?\n/)[0]?.slice(0, 256);
    return {available: true, ...(version === undefined || version.length === 0 ? {} : {version})};
  } catch (cause: unknown) {
    return {
      available: false,
      reason: cause instanceof Error ? redactSensitive(cause.message) : "The adapter executable could not be probed.",
    };
  }
}

function problem(code: string, message: string, detail: string, path?: string): ProblemV1 {
  return {
    schemaVersion: "footgun.problem.v1",
    code,
    message,
    detail,
    ...(path === undefined ? {} : {path}),
    recovery: "Fix the manifest or install the declared adapter executable.",
  };
}
