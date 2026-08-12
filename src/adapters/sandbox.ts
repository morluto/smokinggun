import {constants, existsSync} from "node:fs";
import {access, realpath} from "node:fs/promises";
import {dirname, parse, resolve} from "node:path";
import type {ProblemV1} from "../protocol/index.js";

const bubblewrapPath = "/usr/bin/bwrap";

export type SandboxedCommand = {
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
};

/**
 * Build the only supported static-adapter execution boundary. The repository
 * and runtime are mounted read-only, the rest of the host filesystem is not
 * visible, and the process receives a separate empty network namespace.
 */
export async function sandboxAdapterCommand(
  command: ReadonlyArray<string>,
  root: string,
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
    ...directoryArguments(realRoot),
    "--ro-bind",
    realRoot,
    realRoot,
    "--chdir",
    realRoot,
    "--",
    executable,
    ...command.slice(1),
  ];
  return {executable: bubblewrapPath, arguments: sandboxArguments};
}

function directoryArguments(path: string): string[] {
  const root = parse(path).root;
  const directories: string[] = [];
  for (let current = path; current !== root; current = dirname(current)) directories.push(current);
  return directories.reverse().flatMap((directory) => ["--dir", directory]);
}

function readOnlySystemMounts(): string[] {
  return ["/usr", "/lib", "/lib64", "/bin", "/sbin"].flatMap((path) =>
    existsSync(path) ? ["--ro-bind", path, path] : [],
  );
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
