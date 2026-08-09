import {execa} from "execa";
import {relative, resolve} from "node:path";
import {type ProblemV1, type UnparameterizedWorkloadV2} from "../protocol/index.js";
import {executionEnvironment, redactSensitive} from "./environment.js";

export type RunnerOptions = {
  readonly root: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
};

export type ExecutableWorkloadV2 = Extract<
  UnparameterizedWorkloadV2,
  {readonly requestedProfile: "local-exec" | "container-exec" | "candidate-write"}
>;

type WorkloadExecutionBase = {
  readonly backend: "host-process" | "docker" | "podman" | "bwrap" | "nsjail";
  readonly controlsApplied: ReadonlyArray<string>;
  readonly downgradeReasons: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
};

export type WorkloadExecution =
  | (WorkloadExecutionBase & {readonly outcome: "completed"; readonly exitCode: number})
  | (WorkloadExecutionBase & {readonly outcome: "timed-out"})
  | (WorkloadExecutionBase & {readonly outcome: "cancelled"});

type ProcessResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly isCanceled: boolean;
};

/** Narrow a parsed workload to one of the profiles that may execute a process in this build. */
export function classifyExecutableWorkload(workload: UnparameterizedWorkloadV2): ExecutableWorkloadV2 | ProblemV1 {
  switch (workload.requestedProfile) {
    case "local-exec":
      return workload;
    case "container-exec":
      return workload;
    case "candidate-write":
      return workload;
    case "read-only":
      return problem(
        "execution-profile-unavailable",
        "The read-only profile does not execute workloads; measurement requires an explicit local or isolated execution profile.",
        "Use local-exec for an explicitly authorized host process or container-exec with a pinned runner.",
      );
    case "service-exec":
      return problem(
        "execution-profile-unavailable",
        "The service-exec execution profile is unavailable in this build.",
        "Use local-exec, candidate-write, or container-exec with an explicit runner.",
      );
  }
}

/** Run an explicitly executable workload through the requested process boundary without a shell. */
export async function executeWorkload(
  workload: ExecutableWorkloadV2,
  options: RunnerOptions,
): Promise<WorkloadExecution | ProblemV1> {
  if (workload.requestedProfile === "container-exec") return executeContainer(workload, options);
  const executable = workload.command[0];
  if (executable === undefined)
    return problem("workload-command-empty", "The workload command is empty.", "Declare an executable and arguments.");
  try {
    const result = await execa(executable, workload.command.slice(1), {
      cwd: options.cwd,
      env: executionEnvironment(workload.environment, workload.inheritEnvironment),
      extendEnv: false,
      timeout: workload.timeoutMs,
      forceKillAfterDelay: 250,
      cleanup: true,
      windowsHide: false,
      maxBuffer: 1_000_000,
      reject: false,
      shell: false,
      ...(options.signal === undefined ? {} : {cancelSignal: options.signal}),
    });
    return executionResult(
      {
        backend: "host-process",
        controlsApplied: [
          "no-shell",
          "cwd-boundary",
          "bounded-output",
          ...(workload.requestedProfile === "candidate-write" ? ["candidate-workspace"] : []),
          ...(workload.networkPolicy === "disabled" ? ["network-unrestricted"] : ["network-policy-explicit"]),
        ],
        downgradeReasons:
          workload.networkPolicy === "disabled" ? ["host-process execution cannot enforce network denial"] : [],
        stdout: result.stdout,
        stderr: result.stderr,
      },
      result,
      options.signal,
    );
  } catch (cause: unknown) {
    return problem(
      options.signal?.aborted ? "measurement-cancelled" : "workload-executable-unavailable",
      options.signal?.aborted
        ? "The workload measurement was cancelled."
        : "The workload executable could not be started.",
      cause instanceof Error ? redactSensitive(cause.message) : "Check the executable and rerun the workload.",
    );
  }
}

async function executeContainer(
  workload: Extract<ExecutableWorkloadV2, {readonly requestedProfile: "container-exec"}>,
  options: RunnerOptions,
): Promise<WorkloadExecution | ProblemV1> {
  const runner = workload.runner;
  if (runner.runtime === "bwrap" || runner.runtime === "nsjail")
    return executeLinuxSandbox(workload, options, runner.runtime);
  if (!runner.image.includes("@sha256:"))
    return problem(
      "container-image-unpinned",
      "Container execution requires an immutable image digest.",
      "Use an image reference such as registry.example/app@sha256:<digest>.",
    );
  if (options.root.includes(","))
    return problem(
      "container-path-unsupported",
      "The repository path contains a comma that the OCI mount argument cannot represent safely.",
      "Move the repository to a path without commas before requesting container execution.",
    );
  let available;
  try {
    available = await execa(runner.runtime, ["--version"], {
      reject: false,
      stdin: "ignore",
      timeout: 1_000,
      maxBuffer: 8_192,
      ...(options.signal === undefined ? {} : {cancelSignal: options.signal}),
    });
  } catch (cause: unknown) {
    return problem(
      options.signal?.aborted ? "measurement-cancelled" : "container-runtime-unavailable",
      `The requested ${runner.runtime} runtime is unavailable.`,
      cause instanceof Error
        ? redactSensitive(cause.message)
        : `Install ${runner.runtime} or use a capability-probed local runner.`,
    );
  }
  if (available.exitCode !== 0)
    return problem(
      "container-runtime-unavailable",
      `The requested ${runner.runtime} runtime is unavailable.`,
      `Install ${runner.runtime} or use a capability-probed local runner.`,
    );
  const relativeCwd = relative(options.root, options.cwd);
  const containerCwd = relativeCwd.length === 0 ? "/workspace" : `/workspace/${relativeCwd.split("\\").join("/")}`;
  const environment = executionEnvironment(workload.environment, workload.inheritEnvironment);
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--workdir",
    containerCwd,
    "--mount",
    `type=bind,src=${options.root},dst=/workspace,readonly`,
  ];
  if (workload.resourceLimits?.memoryBytes !== undefined)
    args.push("--memory", String(workload.resourceLimits.memoryBytes));
  if (workload.resourceLimits?.maxProcesses !== undefined)
    args.push("--pids-limit", String(workload.resourceLimits.maxProcesses));
  for (const [key, value] of Object.entries(environment)) args.push("--env", `${key}=${value}`);
  args.push(runner.image, ...workload.command);
  try {
    const result = await execa(runner.runtime, args, {
      cwd: options.root,
      stdin: "ignore",
      timeout: workload.timeoutMs,
      forceKillAfterDelay: 250,
      cleanup: true,
      windowsHide: false,
      maxBuffer: 1_000_000,
      reject: false,
      shell: false,
      ...(options.signal === undefined ? {} : {cancelSignal: options.signal}),
    });
    return executionResult(
      {
        backend: runner.runtime,
        controlsApplied: [
          "no-shell",
          "cwd-boundary",
          "bounded-output",
          "network-none",
          "filesystem-read-only",
          ...(workload.resourceLimits?.memoryBytes === undefined ? [] : ["memory-limit"]),
          ...(workload.resourceLimits?.maxProcesses === undefined ? [] : ["process-limit"]),
        ],
        downgradeReasons: [],
        stdout: result.stdout,
        stderr: result.stderr,
      },
      result,
      options.signal,
    );
  } catch (cause: unknown) {
    return problem(
      options.signal?.aborted ? "measurement-cancelled" : "container-execution-failed",
      `The ${runner.runtime} workload could not be executed.`,
      cause instanceof Error ? redactSensitive(cause.message) : "Inspect the container runtime diagnostics and rerun.",
    );
  }
}

async function executeLinuxSandbox(
  workload: Extract<ExecutableWorkloadV2, {readonly requestedProfile: "container-exec"}>,
  options: RunnerOptions,
  runtime: "bwrap" | "nsjail",
): Promise<WorkloadExecution | ProblemV1> {
  if (workload.resourceLimits?.memoryBytes !== undefined || workload.resourceLimits?.maxProcesses !== undefined)
    return problem(
      "resource-limit-unavailable",
      `${runtime} execution cannot prove the requested memory or process limit in this build.`,
      "Use a runner with cgroup or rlimit support and remove the unsupported limit only deliberately.",
    );
  const executable = workload.command[0];
  if (executable === undefined)
    return problem("workload-command-empty", "The workload command is empty.", "Declare an executable and arguments.");
  if (runtime === "nsjail" && options.root.includes(":"))
    return problem(
      "nsjail-path-unsupported",
      "The repository path contains a colon that the nsjail bind-mount argument cannot represent safely.",
      "Move the repository to a path without colons before requesting nsjail execution.",
    );
  const relativeCwd = relative(resolve(options.root), resolve(options.cwd));
  const sandboxCwd = relativeCwd.length === 0 ? "/workspace" : `/workspace/${relativeCwd.split("\\").join("/")}`;
  const environment = executionEnvironment(workload.environment, workload.inheritEnvironment);
  const args =
    runtime === "bwrap"
      ? bwrapArguments(options.root, sandboxCwd, environment, workload.command)
      : nsjailArguments(options.root, sandboxCwd, environment, workload.command);
  try {
    const result = await execa(runtime, args, {
      cwd: options.root,
      stdin: "ignore",
      timeout: workload.timeoutMs,
      forceKillAfterDelay: 250,
      maxBuffer: 1_000_000,
      reject: false,
      shell: false,
      ...(options.signal === undefined ? {} : {cancelSignal: options.signal}),
    });
    return executionResult(
      {
        backend: runtime,
        controlsApplied:
          runtime === "bwrap"
            ? [
                "no-shell",
                "cwd-boundary",
                "bounded-output",
                "network-none",
                "filesystem-read-only",
                "pid-namespace",
                "system-filesystem-read-only",
                "private-tmp",
                "die-with-parent",
              ]
            : [
                "no-shell",
                "cwd-boundary",
                "bounded-output",
                "network-no-interface",
                "workspace-read-only",
                "die-with-parent",
              ],
        stdout: result.stdout,
        stderr: result.stderr,
        downgradeReasons: [],
      },
      result,
      options.signal,
    );
  } catch (cause: unknown) {
    return problem(
      options.signal?.aborted ? "measurement-cancelled" : "sandbox-execution-failed",
      `The ${runtime} workload could not be executed.`,
      cause instanceof Error
        ? redactSensitive(cause.message)
        : `Install ${runtime} and verify its namespace permissions.`,
    );
  }
}

function executionResult(
  base: WorkloadExecutionBase,
  result: ProcessResult,
  signal: AbortSignal | undefined,
): WorkloadExecution {
  if (result.isCanceled || signal?.aborted === true) return {...base, outcome: "cancelled"};
  if (result.timedOut) return {...base, outcome: "timed-out"};
  return {...base, outcome: "completed", exitCode: result.exitCode ?? -1};
}

function bwrapArguments(
  root: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  command: ReadonlyArray<string>,
): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-net",
    "--unshare-pid",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    root,
    "/workspace",
    "--chdir",
    cwd,
    "--ro-bind-try",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/usr/local",
    "/usr/local",
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc",
    "/etc",
    "--clearenv",
  ];
  for (const [key, value] of Object.entries(environment)) args.push("--setenv", key, value);
  args.push("--", ...command);
  return args;
}

function nsjailArguments(
  root: string,
  cwd: string,
  environment: Readonly<Record<string, string>>,
  command: ReadonlyArray<string>,
): string[] {
  const args = [
    "--mode",
    "o",
    "--quiet",
    "--iface_no_lo",
    "--bindmount_ro",
    `${root}:/workspace`,
    "--cwd",
    cwd,
    "--disable_proc",
  ];
  for (const [key, value] of Object.entries(environment)) args.push("--env", `${key}=${value}`);
  args.push("--", ...command);
  return args;
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}
