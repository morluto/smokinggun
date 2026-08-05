import {execa} from "execa";

export type IsolationBackend = "docker" | "podman" | "bwrap" | "nsjail";

export type IsolationCapability = {
  readonly backend: IsolationBackend;
  readonly available: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly reason?: string;
};

/** Probe optional isolation binaries without starting a workload or contacting a service. */
export async function probeIsolation(signal?: AbortSignal): Promise<ReadonlyArray<IsolationCapability>> {
  const backends: ReadonlyArray<IsolationBackend> = ["docker", "podman", "bwrap", "nsjail"];
  return Promise.all(backends.map(async (backend) => probeBackend(backend, signal)));
}

async function probeBackend(backend: IsolationBackend, signal?: AbortSignal): Promise<IsolationCapability> {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  try {
    const located = await execa(lookup, [backend], {reject: false, stdin: "ignore", ...(signal === undefined ? {} : {cancelSignal: signal}), timeout: 1_000});
    const executable = located.exitCode === 0 ? located.stdout.trim().split(/\r?\n/u)[0] : undefined;
    if (executable === undefined || executable.length === 0) return {backend, available: false, reason: "executable-not-found"};
    const version = await execa(executable, ["--version"], {reject: false, stdin: "ignore", ...(signal === undefined ? {} : {cancelSignal: signal}), timeout: 1_000, maxBuffer: 8_192});
    if (version.exitCode !== 0) return {backend, available: false, executable, reason: "version-probe-failed"};
    const line = version.stdout.trim().split(/\r?\n/u)[0];
    return {backend, available: true, executable, ...(line === undefined || line.length === 0 ? {} : {version: line})};
  } catch (cause: unknown) {
    if (signal?.aborted) throw cause;
    return {backend, available: false, reason: "probe-failed"};
  }
}
