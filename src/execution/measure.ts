import {createHash} from "node:crypto";
import {join, resolve, relative, isAbsolute} from "node:path";
import {cp, lstat, mkdir, mkdtemp, realpath, stat} from "node:fs/promises";
import {
  Protocol,
  isScalingWorkload,
  type MeasurementV1,
  type ProblemV1,
  type ScalingAnalysisV2,
  type ScalingAnalysisV3,
  type WorkloadV2,
} from "../protocol/index.js";
import {executeWorkload} from "./runner.js";
import {stableJson} from "../serialization.js";
import {executionEnvironment, redactCommand} from "./environment.js";
import {isWithinRoot, portablePath} from "../paths.js";

export type MeasurementOptions = {
  readonly root: string;
  readonly workspaceRoot?: string;
  readonly signal?: AbortSignal;
};

/** Execute a declared local workload repeatedly and retain only bounded timing data. */
export async function measureWorkload(input: unknown, options: MeasurementOptions): Promise<MeasurementV1 | ProblemV1> {
  const parsed = Protocol.workload.safeParse(input);
  if (!parsed.success)
    return problem(
      "invalid-workload",
      "The workload is not a valid WorkloadV2 descriptor.",
      "Provide strict JSON with command, cwd, repetitions, timeoutMs, and execution profile.",
    );
  return measureParsedWorkload(parsed.data, options);
}

/** Execute a workload already parsed at the caller's boundary. */
export async function measureParsedWorkload(
  workload: WorkloadV2,
  options: MeasurementOptions,
): Promise<MeasurementV1 | ProblemV1> {
  if (workload.requestedProfile === "read-only")
    return problem(
      "execution-profile-unavailable",
      "The read-only profile does not execute workloads; measurement requires an explicit local or isolated execution profile.",
      "Use local-exec for an explicitly authorized host process or container-exec with a pinned runner.",
    );
  if (
    workload.requestedProfile !== "local-exec" &&
    workload.requestedProfile !== "container-exec" &&
    workload.requestedProfile !== "candidate-write"
  )
    return problem(
      "execution-profile-unavailable",
      `The ${workload.requestedProfile} execution profile is unavailable in this build.`,
      "Use local-exec, candidate-write, or container-exec with an explicit runner.",
    );
  if (isScalingWorkload(workload))
    return problem(
      "scaling-profile-unavailable",
      "This runner does not silently collapse a scaling series into one measurement.",
      "Use the scaling runner that matches the declared parameterization.",
    );
  if (
    workload.resourceLimits?.cpuMs !== undefined ||
    workload.resourceLimits?.memoryBytes !== undefined ||
    workload.resourceLimits?.maxProcesses !== undefined
  )
    if (workload.requestedProfile === "container-exec" && workload.resourceLimits?.cpuMs === undefined) {
      // Docker and Podman apply memory and process controls in the container runner.
    } else
      return problem(
        "resource-limit-unavailable",
        "The available runners cannot enforce every requested CPU, memory, or process limit.",
        "Use a runner with resource-limit support and remove an unsupported limit only when that control is acceptable.",
      );
  const cwd = resolve(options.root, workload.cwd);
  const root = resolve(options.root);
  if (!isWithinRoot(root, cwd))
    return problem(
      "workload-boundary-violation",
      "The workload cwd escapes the repository boundary.",
      "Use a repository-relative cwd.",
    );
  const artifactProblem = await validateExpectedArtifacts(workload.expectedArtifacts, root);
  if (artifactProblem !== undefined) return artifactProblem;
  const workloadDigest = createHash("sha256").update(stableJson(workload)).digest("hex");
  let executionRoot = root;
  let executionCwd = cwd;
  let candidateWorkspace: string | undefined;
  if (workload.requestedProfile === "candidate-write") {
    if (options.workspaceRoot === undefined)
      return problem(
        "candidate-workspace-unavailable",
        "candidate-write requires an injected artifact workspace root.",
        "Run candidate measurements through the SmokingGun CLI or provide workspaceRoot to the library API.",
      );
    candidateWorkspace = await createCandidateWorkspace(root, workload, options.workspaceRoot, workloadDigest);
    executionRoot = candidateWorkspace;
    executionCwd = resolve(candidateWorkspace, workload.cwd);
    if (!isWithinRoot(candidateWorkspace, executionCwd))
      return problem(
        "workload-boundary-violation",
        "The candidate workload cwd escapes the isolated candidate workspace.",
        "Use a repository-relative cwd.",
      );
  }
  const totalRuns = workload.warmups + workload.repetitions;
  const samples: number[] = [];
  const behaviorChecks = workload.behaviorChecks.map((check) => ({check, passed: true}));
  let backend: "host-process" | "docker" | "podman" | "bwrap" | "nsjail" = "host-process";
  let controlsApplied: string[] = ["no-shell", "cwd-boundary", "bounded-output"];
  let downgradeReasons: string[] = [];
  for (let index = 0; index < totalRuns; index += 1) {
    options.signal?.throwIfAborted();
    const started = performance.now();
    const result = await executeWorkload(workload, {
      root: executionRoot,
      cwd: executionCwd,
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    });
    if ("code" in result) return result;
    backend = result.backend;
    controlsApplied = [...result.controlsApplied];
    downgradeReasons = [...result.downgradeReasons];
    const elapsed = performance.now() - started;
    if (result.outcome === "cancelled")
      return problem(
        "measurement-cancelled",
        "The workload measurement was cancelled.",
        "Rerun the measurement when the local process is ready.",
      );
    if (result.outcome === "timed-out")
      return problem(
        "measurement-timeout",
        "The workload exceeded its timeout.",
        "Increase timeoutMs only when the workload contract permits it.",
      );
    if (result.exitCode !== 0)
      return problem(
        "workload-failed",
        `The workload exited with code ${String(result.exitCode)}.`,
        "Fix the workload or behavior precondition before measuring.",
      );
    const producedArtifactProblem = await validateProducedArtifacts(workload.expectedArtifacts, executionRoot);
    if (producedArtifactProblem !== undefined) return producedArtifactProblem;
    evaluateBehaviorChecks(workload.behaviorChecks, behaviorChecks, result.exitCode, result.stdout, result.stderr);
    if (index >= workload.warmups) samples.push(elapsed);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
  const meanMs = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const quartiles = {q1Ms: quantile(sorted, 0.25), q3Ms: quantile(sorted, 0.75)};
  return {
    schemaVersion: "footgun.measurement.v1",
    id: `meas_${createHash("sha256").update(`${workloadDigest}\0${Date.now()}`).digest("hex").slice(0, 16)}`,
    workloadDigest,
    samplesMs: samples,
    warmups: workload.warmups,
    repetitions: workload.repetitions,
    medianMs,
    meanMs,
    quartiles,
    statisticalPolicy: workload.statisticalPolicy,
    reproduction: {
      command: redactCommand(workload.command, root),
      cwd: portablePath(relative(root, cwd) || "."),
      environmentKeys: Object.keys(executionEnvironment(workload.environment, workload.inheritEnvironment)).sort(),
      timeoutMs: workload.timeoutMs,
      warmups: workload.warmups,
      repetitions: workload.repetitions,
      expectedArtifacts: workload.expectedArtifacts.map((artifact) => portablePath(artifact)).sort(),
      datasetDigests: workload.datasetDigests,
    },
    behaviorValidated: behaviorChecks.length > 0 && behaviorChecks.every((check) => check.passed),
    executionProfile: workload.requestedProfile,
    environment: {node: process.versions.node, platform: process.platform, arch: process.arch},
    isolation: {
      backend,
      controlsRequested: [
        "no-shell",
        "cwd-boundary",
        "bounded-output",
        ...(workload.requestedProfile === "candidate-write" ? ["candidate-workspace"] : []),
        ...(workload.resourceLimits?.memoryBytes === undefined ? [] : ["memory-limit"]),
        ...(workload.resourceLimits?.maxProcesses === undefined ? [] : ["process-limit"]),
      ],
      controlsApplied,
      downgradeReasons,
      ...(candidateWorkspace === undefined
        ? {}
        : {candidateWorkspace: portablePath(relative(options.workspaceRoot ?? root, candidateWorkspace))}),
      ...(backend === "host-process" || workload.runner === undefined ? {} : {runner: workload.runner}),
    },
    ...(behaviorChecks.length === 0 ? {} : {behaviorChecks}),
  };
}

async function validateExpectedArtifacts(
  artifacts: ReadonlyArray<string>,
  root: string,
): Promise<ProblemV1 | undefined> {
  for (const artifact of artifacts) {
    const candidate = resolve(root, artifact);
    if (isAbsolute(artifact) || !isWithinRoot(root, candidate))
      return problem(
        "workload-artifact-boundary-violation",
        "An expected workload artifact escapes the repository boundary.",
        "Use repository-relative expectedArtifacts paths.",
      );
    const existing = await lstat(candidate).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing !== undefined && !existing.isFile()))
      return problem(
        "workload-artifact-boundary-violation",
        "An expected workload artifact is an existing symlink or non-file.",
        "Use repository-relative regular-file artifact paths.",
      );
  }
  return undefined;
}

async function validateProducedArtifacts(
  artifacts: ReadonlyArray<string>,
  root: string,
): Promise<ProblemV1 | undefined> {
  const realRoot = await realpath(root).catch(() => root);
  for (const artifact of artifacts) {
    const candidate = resolve(root, artifact);
    const linkInfo = await lstat(candidate).catch(() => undefined);
    const info = await stat(candidate).catch(() => undefined);
    if (info === undefined) continue;
    const actual = await realpath(candidate).catch(() => undefined);
    if (linkInfo?.isSymbolicLink() || actual === undefined || !isWithinRoot(realRoot, actual) || !info.isFile())
      return problem(
        "workload-artifact-boundary-violation",
        "A produced workload artifact resolves outside the repository boundary, is not a regular file, or is a symlink.",
        "Keep expected artifacts as regular files below the repository root.",
      );
  }
  return undefined;
}

function quantile(sorted: ReadonlyArray<number>, fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function evaluateBehaviorChecks(
  checks: ReadonlyArray<string>,
  results: Array<{check: string; passed: boolean}>,
  exitCode: number,
  stdout: string,
  stderr: string,
): void {
  for (const [index, check] of checks.entries()) {
    const result = results[index];
    if (result === undefined) continue;
    if (check.startsWith("exit-code:")) {
      const expected = check.slice("exit-code:".length);
      result.passed &&= String(exitCode) === expected;
      continue;
    }
    if (check.startsWith("stdout-sha256:")) {
      const expected = check.slice("stdout-sha256:".length);
      const observed = createHash("sha256").update(stdout).digest("hex");
      result.passed &&= observed === expected;
      continue;
    }
    if (check.startsWith("stderr-sha256:")) {
      const expected = check.slice("stderr-sha256:".length);
      const observed = createHash("sha256").update(stderr).digest("hex");
      result.passed &&= observed === expected;
      continue;
    }
    result.passed = false;
  }
}

async function createCandidateWorkspace(
  sourceRoot: string,
  workload: WorkloadV2,
  workspaceRoot: string,
  digest: string,
): Promise<string> {
  const source = resolve(sourceRoot);
  const store = resolve(workspaceRoot);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error("The candidate-write source must be a regular directory and cannot be a symlink.");
  const candidates = resolve(store, "candidates");
  await mkdir(candidates, {recursive: true});
  const autoCreated = workload.candidateRoot === undefined;
  const destination = autoCreated
    ? await mkdtemp(`${join(candidates, `candidate-${digest.slice(0, 16)}-`)}`)
    : resolve(store, workload.candidateRoot ?? "");
  if (!isWithinRoot(store, destination))
    throw new Error("The candidate workspace must remain inside the artifact workspace root.");
  if (isWithinRoot(source, destination))
    throw new Error("The candidate workspace cannot be inside the source repository.");
  const existing = autoCreated ? undefined : await lstat(destination).catch(() => undefined);
  if (existing !== undefined) throw new Error("The candidate workspace already exists; choose a fresh candidateRoot.");
  await mkdir(destination, {recursive: true});
  await cp(source, destination, {
    recursive: true,
    filter: async (path) =>
      !(await lstat(path)
        .then((info) => info.isSymbolicLink())
        .catch(() => true)),
  });
  return destination;
}

export function parseMeasurement(input: unknown): MeasurementV1 | ProblemV1 {
  const result = Protocol.measurement.safeParse(input);
  return result.success
    ? result.data
    : problem(
        "invalid-measurement",
        "The artifact is not a valid SmokingGun MeasurementV1.",
        "Regenerate it with `smokinggun measure`.",
      );
}

export function parseMeasurementArtifact(
  input: unknown,
): MeasurementV1 | ScalingAnalysisV2 | ScalingAnalysisV3 | ProblemV1 {
  const multiScaling = Protocol.multiScaling.safeParse(input);
  if (multiScaling.success) return multiScaling.data;
  const scaling = Protocol.scaling.safeParse(input);
  if (scaling.success) return scaling.data;
  const measurement = Protocol.measurement.safeParse(input);
  return measurement.success
    ? measurement.data
    : problem(
        "invalid-measurement-artifact",
        "The artifact is not a valid MeasurementV1 or ScalingAnalysisV2.",
        "Regenerate it with `smokinggun measure`.",
      );
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}
