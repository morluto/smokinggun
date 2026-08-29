import {mkdir} from "node:fs/promises";
import {execa} from "execa";
import {join} from "node:path";
import type {OutputFormat, RuntimeConfig} from "../config.js";
import type {ScanProfile} from "../scan/profile.js";
import {isConfigFailure, loadConfig, userDataDirectory} from "../config.js";
import type {ProblemV1} from "../protocol/index.js";
import {storeArtifact, storeArtifactBytes, type StoredArtifact} from "../artifacts/store.js";

export type GlobalFlags = {
  readonly cwd?: string;
  readonly config?: string;
  readonly format?: OutputFormat;
  readonly output?: string;
  readonly noColor?: boolean;
  readonly quiet?: boolean;
  readonly debug?: boolean;
  readonly nonInteractive?: boolean;
  readonly strict?: boolean;
  readonly failOn?: string;
  readonly sourceProfile?: ScanProfile;
  readonly exclude?: ReadonlyArray<string>;
  readonly maxFindings?: number;
};

export type RuntimeContext = {
  readonly config: RuntimeConfig;
  readonly signal: AbortSignal;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly artifacts: string;
  readonly artifactStore: {
    readonly root: string;
    readonly put: (path: string, maxBytes?: number) => Promise<StoredArtifact>;
    readonly putBytes: (path: string, bytes: Uint8Array, maxBytes?: number) => Promise<StoredArtifact>;
  };
  readonly executionPolicy: {readonly network: "disabled"; readonly shell: false; readonly maxOutputBytes: number};
  readonly clock: {readonly now: () => number; readonly nowIso: () => string};
  readonly processRunner: typeof execa;
};

export type ContextFailure = ProblemV1 & {_tag: "ContextFailure"; exitCode: 2};

/** Compose parsed configuration and process boundaries for one command invocation. */
export async function createRuntimeContext(
  flags: GlobalFlags,
  signal: AbortSignal,
  streams: Pick<RuntimeContext, "stdin" | "stdout" | "stderr"> = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<RuntimeContext | ContextFailure> {
  const config = await loadConfig(flags);
  if (isConfigFailure(config)) return {...config, _tag: "ContextFailure", exitCode: 2};
  const artifacts = userDataDirectory();
  const artifactRoot = join(artifacts, "artifacts");
  return {
    ...streams,
    config,
    signal,
    artifacts,
    artifactStore: {
      root: artifactRoot,
      put: (path, maxBytes) => storeArtifactWithLazyInit(path, artifactRoot, maxBytes),
      putBytes: (path, bytes, maxBytes) => storeArtifactBytesWithLazyInit(path, bytes, artifactRoot, maxBytes),
    },
    executionPolicy: {network: "disabled", shell: false, maxOutputBytes: 1_000_000},
    clock: {now: () => Date.now(), nowIso: () => new Date().toISOString()},
    processRunner: execa,
  };
}

export function isContextFailure(value: RuntimeContext | ContextFailure): value is ContextFailure {
  return "_tag" in value;
}

async function storeArtifactWithLazyInit(path: string, root: string, maxBytes?: number): Promise<StoredArtifact> {
  try {
    return await storeArtifact(path, root, maxBytes);
  } catch (reason: unknown) {
    if (isEnoentError(reason)) {
      await mkdir(root, {recursive: true});
      return storeArtifact(path, root, maxBytes);
    }
    throw reason;
  }
}

async function storeArtifactBytesWithLazyInit(
  path: string,
  bytes: Uint8Array,
  root: string,
  maxBytes?: number,
): Promise<StoredArtifact> {
  try {
    return await storeArtifactBytes(path, bytes, root, maxBytes);
  } catch (reason: unknown) {
    if (isEnoentError(reason)) {
      await mkdir(root, {recursive: true});
      return storeArtifactBytes(path, bytes, root, maxBytes);
    }
    throw reason;
  }
}

function isEnoentError(reason: unknown): boolean {
  return reason instanceof Error && "code" in reason && reason.code === "ENOENT";
}
