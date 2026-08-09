import {createHash} from "node:crypto";
import {join, resolve, relative} from "node:path";
import {cp, lstat, mkdir, mkdtemp, realpath, stat} from "node:fs/promises";
import {
  Protocol,
  classifyWorkload,
  type MeasurementArtifactV1,
  type MeasurementV1,
  type ProblemV1,
  type UnparameterizedWorkloadV2,
} from "../protocol/index.js";
import {classifyExecutableWorkload, executeWorkload, type ExecutableWorkloadV2} from "./runner.js";
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
  const workload = classifyWorkload(parsed.data);
  if (workload.kind !== "unparameterized")
    return problem(
      "scaling-profile-unavailable",
      "This runner does not silently collapse a scaling series into one measurement.",
      "Use the scaling runner that matches the declared parameterization.",
    );
  return measureParsedWorkload(workload.workload, options);
}

/** Execute a workload already parsed at the caller's boundary. */
export async function measureParsedWorkload(
  workload: UnparameterizedWorkloadV2,
  options: MeasurementOptions,
): Promise<MeasurementV1 | ProblemV1> {
  const executableWorkload = classifyExecutableWorkload(workload);
  if ("code" in executableWorkload) return executableWorkload;
  const cwd = resolve(options.root, workload.cwd);
  const root = resolve(options.root);
  if (!(await isWithinRealRoot(root, cwd)))
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
    if (!(await isWithinRealRoot(candidateWorkspace, executionCwd)))
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
    const result = await executeWorkload(executableWorkload, {
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
  const behavior =
    behaviorChecks.length > 0 && behaviorChecks.every((check) => check.passed)
      ? {behaviorValidated: true as const, behaviorChecks}
      : behaviorChecks.length === 0
        ? {behaviorValidated: false as const}
        : {behaviorValidated: false as const, behaviorChecks};
  return Protocol.measurement.parse({
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
    ...behavior,
    executionProfile: executableWorkload.requestedProfile,
    environment: {node: process.versions.node, platform: process.platform, arch: process.arch},
    isolation: measurementIsolation(
      executableWorkload,
      backend,
      [
        "no-shell",
        "cwd-boundary",
        "bounded-output",
        ...(workload.requestedProfile === "candidate-write" ? ["candidate-workspace"] : []),
        ...(workload.resourceLimits?.memoryBytes === undefined ? [] : ["memory-limit"]),
        ...(workload.resourceLimits?.maxProcesses === undefined ? [] : ["process-limit"]),
      ],
      controlsApplied,
      downgradeReasons,
      candidateWorkspace === undefined
        ? undefined
        : portablePath(relative(options.workspaceRoot ?? root, candidateWorkspace)),
    ),
  });
}

function measurementIsolation(
  workload: ExecutableWorkloadV2,
  backend: MeasurementV1["isolation"]["backend"],
  controlsRequested: string[],
  controlsApplied: string[],
  downgradeReasons: string[],
  candidateWorkspace: string | undefined,
): MeasurementV1["isolation"] {
  const details = {controlsRequested, controlsApplied, downgradeReasons};
  if (backend === "host-process") {
    if (workload.requestedProfile === "local-exec") return {backend, ...details};
    if (workload.requestedProfile !== "candidate-write" || candidateWorkspace === undefined)
      throw new Error("Host-process measurement isolation requires a parsed local or candidate workload.");
    return {backend, ...details, candidateWorkspace};
  }
  if (workload.requestedProfile !== "container-exec")
    throw new Error(`Execution backend ${backend} requires a parsed container workload.`);
  switch (backend) {
    case "docker":
      if (workload.runner.runtime !== backend)
        throw new Error("Execution backend docker does not match the parsed runner.");
      return {backend, ...details, runner: workload.runner};
    case "podman":
      if (workload.runner.runtime !== backend)
        throw new Error("Execution backend podman does not match the parsed runner.");
      return {backend, ...details, runner: workload.runner};
    case "bwrap":
      if (workload.runner.runtime !== backend)
        throw new Error("Execution backend bwrap does not match the parsed runner.");
      return {backend, ...details, runner: workload.runner};
    case "nsjail":
      if (workload.runner.runtime !== backend)
        throw new Error("Execution backend nsjail does not match the parsed runner.");
      return {backend, ...details, runner: workload.runner};
  }
}

async function validateExpectedArtifacts(
  artifacts: ReadonlyArray<string>,
  root: string,
): Promise<ProblemV1 | undefined> {
  for (const artifact of artifacts) {
    const candidate = resolve(root, artifact);
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
  workload: UnparameterizedWorkloadV2,
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

export function parseMeasurementArtifact(input: unknown): MeasurementArtifactV1 | ProblemV1 {
  const parsed = Protocol.measurementArtifact.safeParse(input);
  return parsed.success
    ? parsed.data
    : problem(
        "invalid-measurement-artifact",
        "The artifact is not a valid MeasurementV1 or ScalingAnalysisV2.",
        "Regenerate it with `smokinggun measure`.",
      );
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}

async function isWithinRealRoot(root: string, candidate: string): Promise<boolean> {
  const [realRoot, realCandidate] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(candidate).catch(() => candidate),
  ]);
  return isWithinRoot(realRoot, realCandidate);
}
