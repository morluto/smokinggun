import {isAbsolute, relative, resolve} from "node:path";
import {execa} from "execa";
import {Protocol, type AdapterManifestV1, type ProblemV1} from "../protocol/index.js";
import {executionEnvironment, redactSensitive} from "../adapters/environment.js";
import {readBoundedUtf8File} from "../files.js";
import {comparePortable, portablePath} from "../paths.js";
import {sandboxAdapterCommand} from "../adapters/sandbox.js";
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

export type LoadedExternalAdapters = {
  readonly adapters: ReadonlyArray<LoadedExternalAdapter>;
  readonly descriptors: ReadonlyArray<ExternalScannerDescriptor>;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
};

export type ParsedExternalAdapter = {
  readonly manifest: AdapterManifestV1;
  readonly path: string;
};

export type ParsedExternalAdapters = {
  readonly adapters: ReadonlyArray<ParsedExternalAdapter>;
  readonly invalidDescriptors: ReadonlyArray<ExternalScannerDescriptor>;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
};

export type AdapterExecutionAuthorization =
  | {readonly _tag: "AdapterExecutionNotAuthorized"}
  | {readonly _tag: "AdapterExecutionAuthorized"};

export const adapterExecutionNotAuthorized: AdapterExecutionAuthorization = {
  _tag: "AdapterExecutionNotAuthorized",
};

export const adapterExecutionAuthorized: AdapterExecutionAuthorization = {
  _tag: "AdapterExecutionAuthorized",
};

const maxAdapterManifestBytes = 1024 * 1024;

export function noExternalAdapters(): ParsedExternalAdapters {
  return {adapters: [], invalidDescriptors: [], diagnostics: []};
}

type ExternalAdapterProbe =
  | {readonly available: true; readonly version?: string}
  | {readonly available: false; readonly reason: string};

/** Parse adapter manifests without probing or executing their declared commands. */
export async function parseExternalAdapters(
  paths: ReadonlyArray<string>,
  root: string,
  signal?: AbortSignal,
): Promise<ParsedExternalAdapters> {
  const parsedAdapters: ParsedExternalAdapter[] = [];
  const invalidDescriptors: ExternalScannerDescriptor[] = [];
  const diagnostics: ProblemV1[] = [];
  for (const inputPath of [...new Set(paths.map((path) => resolve(root, path)))].sort(comparePortable)) {
    signal?.throwIfAborted();
    const manifestPath = portableManifestPath(root, inputPath);
    const manifestLabel = manifestPath ?? "the supplied external manifest";
    let input: unknown;
    try {
      input = JSON.parse(await readBoundedUtf8File(inputPath, maxAdapterManifestBytes));
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? redactSensitive(cause.message) : "The manifest could not be read.";
      diagnostics.push(
        problem(
          "adapter-manifest-read-failed",
          `Could not read adapter manifest ${manifestLabel}.`,
          detail,
          manifestPath,
        ),
      );
      invalidDescriptors.push({
        id: inputPath,
        version: "unknown",
        kind: "adapter",
        capabilities: [],
        availability: "invalid",
        manifestPath: manifestLabel,
        reason: detail,
      });
      continue;
    }
    const parsed = Protocol.adapterManifest.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      diagnostics.push(
        problem("invalid-adapter-manifest", `Adapter manifest ${manifestLabel} is invalid.`, detail, manifestPath),
      );
      invalidDescriptors.push({
        id: inputPath,
        version: "unknown",
        kind: "adapter",
        capabilities: [],
        availability: "invalid",
        manifestPath: manifestLabel,
        reason: detail,
      });
      continue;
    }
    parsedAdapters.push({manifest: parsed.data, path: inputPath});
  }
  const adapterPathsById = new Map<string, string[]>();
  for (const adapter of parsedAdapters) {
    const pathsForId = adapterPathsById.get(adapter.manifest.id) ?? [];
    pathsForId.push(adapter.path);
    adapterPathsById.set(adapter.manifest.id, pathsForId);
  }
  const adapters: ParsedExternalAdapter[] = [];
  for (const adapter of parsedAdapters) {
    const pathsForId = adapterPathsById.get(adapter.manifest.id) ?? [];
    if (pathsForId.length === 1) {
      adapters.push(adapter);
      continue;
    }
    const detail = `Adapter ID ${adapter.manifest.id} is declared by multiple manifests: ${pathsForId
      .map((path) => portableManifestPath(root, path) ?? "an external manifest")
      .sort(comparePortable)
      .join(", ")}.`;
    const manifestPath = portableManifestPath(root, adapter.path);
    diagnostics.push(problem("duplicate-adapter-id", "Adapter manifest IDs must be unique.", detail, manifestPath));
    invalidDescriptors.push({
      id: adapter.manifest.id,
      version: adapter.manifest.version,
      kind: "adapter",
      capabilities: adapter.manifest.capabilities,
      availability: "invalid",
      manifestPath: manifestPath ?? "external manifest",
      ...(adapter.manifest.tool === undefined ? {} : {tool: adapter.manifest.tool}),
      reason: detail,
    });
  }
  return {
    adapters: adapters.sort((left, right) => comparePortable(left.manifest.id, right.manifest.id)),
    invalidDescriptors: invalidDescriptors.sort((left, right) => comparePortable(left.id, right.id)),
    diagnostics,
  };
}

/** Probe parsed adapters only under the explicit authorization carried by the caller. */
export async function resolveExternalAdapters(
  parsed: ParsedExternalAdapters,
  root: string,
  options: {
    readonly signal?: AbortSignal;
    readonly authorization: AdapterExecutionAuthorization;
    readonly runtimeRoots?: ReadonlyArray<string>;
  },
): Promise<LoadedExternalAdapters> {
  const {signal} = options;
  const executionAuthorized = options.authorization._tag === "AdapterExecutionAuthorized";
  const adapters: LoadedExternalAdapter[] = [];
  const descriptors: ExternalScannerDescriptor[] = [...parsed.invalidDescriptors];
  const diagnostics: ProblemV1[] = [...parsed.diagnostics];
  for (const adapter of parsed.adapters) {
    signal?.throwIfAborted();
    const {manifest, path} = adapter;
    const manifestPath = portableManifestPath(root, path);
    if (!executionAuthorized) {
      const reason =
        "Adapter execution requires explicit authorization; rerun with --allow-adapter-execution to probe it.";
      diagnostics.push(
        problem(
          "adapter-execution-required",
          `Adapter ${manifest.id} was not probed or executed.`,
          reason,
          manifestPath,
        ),
      );
      const descriptor: ExternalScannerDescriptor = {
        id: manifest.id,
        version: manifest.version,
        kind: "adapter",
        capabilities: manifest.capabilities,
        availability: "unavailable",
        manifestPath: manifestPath ?? "external manifest",
        ...(manifest.tool === undefined ? {} : {tool: manifest.tool}),
        reason,
      };
      descriptors.push(descriptor);
      adapters.push({manifest, path, descriptor});
      continue;
    }
    if (manifest.sideEffects.includes("network")) {
      const reason = "Network-capable adapters are blocked by SmokingGun's offline static policy.";
      diagnostics.push(
        problem("adapter-network-blocked", `Adapter ${manifest.id} was not probed or executed.`, reason, manifestPath),
      );
      const descriptor: ExternalScannerDescriptor = {
        id: manifest.id,
        version: manifest.version,
        kind: "adapter",
        capabilities: manifest.capabilities,
        availability: "unavailable",
        manifestPath: manifestPath ?? "external manifest",
        ...(manifest.tool === undefined ? {} : {tool: manifest.tool}),
        reason,
      };
      descriptors.push(descriptor);
      adapters.push({manifest, path, descriptor});
      continue;
    }
    const probe = await probeExternalAdapter(manifest, root, options.runtimeRoots, signal);
    const descriptor: ExternalScannerDescriptor = probe.available
      ? {
          id: manifest.id,
          version: probe.version ?? manifest.version,
          kind: "adapter",
          capabilities: manifest.capabilities,
          availability: "available",
          manifestPath: manifestPath ?? "external manifest",
          ...(manifest.tool === undefined ? {} : {tool: manifest.tool}),
        }
      : {
          id: manifest.id,
          version: manifest.version,
          kind: "adapter",
          capabilities: manifest.capabilities,
          availability: "unavailable",
          manifestPath: manifestPath ?? "external manifest",
          ...(manifest.tool === undefined ? {} : {tool: manifest.tool}),
          reason: probe.reason,
        };
    descriptors.push(descriptor);
    adapters.push({manifest, path, descriptor});
  }
  return {
    adapters: adapters.sort((left, right) => comparePortable(left.manifest.id, right.manifest.id)),
    descriptors: descriptors.sort((left, right) => comparePortable(left.id, right.id)),
    diagnostics,
  };
}

/** Parse and resolve external adapters in one call for library consumers that need both steps. */
export async function loadExternalAdapters(
  paths: ReadonlyArray<string>,
  root: string,
  options: {
    readonly signal?: AbortSignal;
    readonly authorization: AdapterExecutionAuthorization;
    readonly runtimeRoots?: ReadonlyArray<string>;
  },
): Promise<LoadedExternalAdapters> {
  const parsed = await parseExternalAdapters(paths, root, options.signal);
  return resolveExternalAdapters(parsed, root, options);
}

async function probeExternalAdapter(
  manifest: AdapterManifestV1,
  root: string,
  runtimeRoots?: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<ExternalAdapterProbe> {
  const command = manifest.probeCommand ?? [...manifest.command, "--version"];
  const sandboxed = await sandboxAdapterCommand(command, root, runtimeRoots);
  if ("schemaVersion" in sandboxed) return {available: false, reason: sandboxed.message};
  try {
    const result = await execa(sandboxed.executable, sandboxed.arguments, {
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
    schemaVersion: "smokinggun.problem.v1",
    code,
    message,
    detail,
    ...(path === undefined ? {} : {path}),
    recovery: "Fix the manifest or install the declared adapter executable.",
  };
}

function portableManifestPath(root: string, path: string): string | undefined {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === "") return ".";
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  )
    return undefined;
  return portablePath(relativePath);
}
