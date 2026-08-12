import {constants, existsSync} from "node:fs";
import {access, realpath} from "node:fs/promises";
import {delimiter, dirname, isAbsolute, parse, resolve} from "node:path";
import type {ProblemV1} from "../protocol/index.js";
import {isWithinRoot} from "../paths.js";

const bubblewrapPath = "/usr/bin/bwrap";
const systemMountPaths = ["/usr", "/lib", "/lib64", "/bin", "/sbin"] as const;

export type SandboxedCommand = {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly resolvedExecutable: string;
};

/**
 * Build the only supported static-adapter execution boundary. The repository
 * and runtime are mounted read-only, the rest of the host filesystem is not
 * visible, and the process receives a separate empty network namespace.
 */
export async function sandboxAdapterCommand(
  command: ReadonlyArray<string>,
  root: string,
  declaredRuntimeRoots: ReadonlyArray<string> = [],
): Promise<SandboxedCommand | ProblemV1> {
  if (process.platform !== "linux" || !(await isExecutable(bubblewrapPath)))
    return problem(
      "adapter-sandbox-unavailable",
      "No enforcing static-adapter sandbox is available on this host.",
      "Run built-in scanners, or install Bubblewrap on Linux before authorizing an adapter.",
    );

  const executable = command[0];
  if (executable === undefined || executable.length === 0)
    return problem(
      "adapter-command-empty",
      "The adapter command is empty.",
      "Declare an executable and arguments in the manifest.",
    );

  const realRoot = await realpath(root).catch(() => resolve(root));
  const resolvedExecutable = await resolveExecutable(executable, realRoot);
  if (resolvedExecutable === undefined)
    return problem(
      "adapter-executable-unavailable",
      "The declared adapter executable could not be resolved to an executable host file.",
      "Install the executable or declare an absolute executable path in the adapter manifest.",
    );
  const runtimeRoots = await resolveRuntimeRoots(declaredRuntimeRoots, realRoot);
  if ("schemaVersion" in runtimeRoots) return runtimeRoots;
  const sandboxArguments = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--tmpfs",
    "/",
    ...readOnlySystemMounts(),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...runtimeMountArguments(resolvedExecutable, runtimeRoots),
    ...directoryArguments(realRoot),
    "--ro-bind",
    realRoot,
    realRoot,
    "--chdir",
    realRoot,
    "--",
    resolvedExecutable,
    ...command.slice(1),
  ];
  return {executable: bubblewrapPath, arguments: sandboxArguments, resolvedExecutable};
}

async function resolveExecutable(executable: string, root: string): Promise<string | undefined> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : executable.includes("/") || executable.includes("\\")
      ? [resolve(root, executable)]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .filter((entry) => entry.length > 0)
          .map((entry) => resolve(entry, executable));
  for (const candidate of candidates) {
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical !== undefined && (await isExecutable(canonical))) return canonical;
  }
  return undefined;
}

async function resolveRuntimeRoots(
  declaredRoots: ReadonlyArray<string>,
  sourceRoot: string,
): Promise<ReadonlyArray<string> | ProblemV1> {
  const roots = new Set<string>();
  for (const declared of declaredRoots) {
    const canonical = await realpath(declared).catch(() => undefined);
    if (
      canonical === undefined ||
      canonical === parse(canonical).root ||
      isWithinRoot(sourceRoot, canonical) ||
      isWithinRoot(canonical, sourceRoot)
    )
      return problem(
        "adapter-runtime-root-invalid",
        "A declared adapter runtime root is unavailable, overly broad, or overlaps the source snapshot.",
        "Declare the narrow installed package or runtime directory required by the adapter.",
      );
    roots.add(canonical);
  }
  return [...roots];
}

function runtimeMountArguments(executable: string, runtimeRoots: ReadonlyArray<string>): string[] {
  const executableMount = systemMountPaths.some((path) => isWithinRoot(path, executable))
    ? []
    : [...directoryArguments(dirname(executable)), "--ro-bind", executable, executable];
  return [
    ...executableMount,
    ...runtimeRoots.flatMap((runtimeRoot) => [
      ...directoryArguments(runtimeRoot),
      "--ro-bind",
      runtimeRoot,
      runtimeRoot,
    ]),
  ];
}

function directoryArguments(path: string): string[] {
  const root = parse(path).root;
  const directories: string[] = [];
  for (let current = path; current !== root; current = dirname(current)) directories.push(current);
  return directories.reverse().flatMap((directory) => ["--dir", directory]);
}

function readOnlySystemMounts(): string[] {
  return systemMountPaths.flatMap((path) => (existsSync(path) ? ["--ro-bind", path, path] : []));
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "smokinggun.problem.v1", code, message, recovery};
}
