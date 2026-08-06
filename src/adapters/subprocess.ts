import {isAbsolute, relative, resolve} from "node:path";
import {lstat, realpath, stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execa} from "execa";
import {Protocol, type AdapterResultV1, type ProblemV1} from "../protocol/index.js";
import {executionEnvironment, redactCommand, redactSensitive} from "../execution/environment.js";
import {isWithinRoot, portablePath} from "../paths.js";
import {stableJson} from "../serialization.js";

export type AdapterRunOptions = {
  readonly root: string;
  readonly signal?: AbortSignal;
};

/**
 * Run one trusted, explicitly installed adapter process through the versioned
 * JSON stdin/stdout protocol. Manifest commands are executable code and must
 * never be accepted from an untrusted report or repository artifact.
 */
export async function runSubprocessAdapter(
  manifestInput: unknown,
  requestInput: unknown,
  options: AdapterRunOptions,
): Promise<AdapterResultV1 | ProblemV1> {
  const manifest = Protocol.adapterManifest.safeParse(manifestInput);
  if (!manifest.success)
    return problem("invalid-adapter-manifest", "The adapter manifest is invalid.", "Fix the manifest and retry.");
  const request = Protocol.adapterRequest.safeParse(requestInput);
  if (!request.success)
    return problem(
      "invalid-adapter-request",
      "The adapter request is invalid.",
      "Regenerate the request from the supported protocol version.",
    );
  const command = manifest.data.command;
  const executable = command[0];
  if (executable === undefined)
    return problem(
      "adapter-command-empty",
      "The adapter command is empty.",
      "Declare an executable and arguments in the manifest.",
    );
  const identity = {
    id: manifest.data.id,
    version: manifest.data.version,
    command: redactCommand(manifest.data.command, options.root),
  };
  const requestDigest = createHash("sha256").update(stableJson(request.data)).digest("hex");
  const failure = (state: AdapterResultV1["state"], message: string): AdapterResultV1 => ({
    ...failedAdapter(request.data.requestId, state, message, requestDigest),
    adapter: identity,
    ...(request.data.configDigest === undefined ? {} : {configDigest: request.data.configDigest}),
    ...(request.data.sourceDigest === undefined ? {} : {sourceDigest: request.data.sourceDigest}),
  });
  try {
    const result = await execa(executable, command.slice(1), {
      cwd: options.root,
      input: JSON.stringify(request.data),
      timeout: manifest.data.limits.timeoutMs,
      forceKillAfterDelay: 250,
      cleanup: true,
      windowsHide: false,
      maxBuffer: manifest.data.limits.maxOutputBytes,
      env: executionEnvironment({}, false),
      extendEnv: false,
      reject: false,
      shell: false,
      ...(options.signal === undefined ? {} : {cancelSignal: options.signal}),
    });
    if (result.isCanceled || options.signal?.aborted) return failure("cancelled", "The adapter process was cancelled.");
    if (result.timedOut) return failure("failed", "The adapter exceeded its declared timeout.");
    let output: unknown;
    try {
      output = JSON.parse(result.stdout);
    } catch {
      return failure("failed", "The adapter did not return one valid JSON document on stdout.");
    }
    const parsed = Protocol.adapterResult.safeParse(output);
    if (!parsed.success)
      return problem(
        "invalid-adapter-result",
        "The adapter result does not satisfy AdapterResultV1.",
        "Update the adapter to the supported protocol version.",
      );
    if (parsed.data.requestId !== request.data.requestId)
      return problem(
        "adapter-request-mismatch",
        "The adapter result requestId does not match the request.",
        "Run the adapter once per request and preserve requestId.",
      );
    const boundaryProblem = await checkArtifacts(parsed.data, options.root, manifest.data.limits.maxArtifactBytes);
    if (boundaryProblem !== undefined) return boundaryProblem;
    const findingBoundaryProblem = checkFindingLocations(parsed.data, options.root);
    if (findingBoundaryProblem !== undefined) return findingBoundaryProblem;
    if (result.exitCode !== 0 && parsed.data.state === "complete")
      return failure("failed", "The adapter exited nonzero while claiming complete output.");
    const stderr = redactSensitive(result.stderr.trim()).slice(0, 8_192);
    return {
      ...parsed.data,
      requestDigest,
      ...(request.data.configDigest === undefined ? {} : {configDigest: request.data.configDigest}),
      ...(request.data.sourceDigest === undefined ? {} : {sourceDigest: request.data.sourceDigest}),
      ...(stderr.length === 0
        ? {}
        : {
            diagnostics: [
              ...parsed.data.diagnostics,
              {
                schemaVersion: "footgun.problem.v1" as const,
                code: "adapter-stderr",
                message: "The adapter wrote diagnostics to stderr.",
                detail: stderr,
                recovery: "Inspect the adapter stderr while preserving stdout as the versioned result.",
              },
            ],
          }),
      adapter: identity,
    };
  } catch (cause: unknown) {
    if (cause instanceof Error && /max.?buffer|output limit/i.test(cause.message))
      return failure("failed", "The adapter exceeded its bounded output limit.");
    return problem(
      "adapter-execution-failed",
      cause instanceof Error ? redactSensitive(cause.message) : "The adapter process could not be started.",
      "Check the executable identity and local adapter installation.",
    );
  }
}

async function checkArtifacts(
  result: AdapterResultV1,
  root: string,
  maxArtifactBytes: number,
): Promise<ProblemV1 | undefined> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  for (const artifact of result.rawArtifacts) {
    if (isAbsolute(artifact))
      return problem(
        "artifact-boundary-violation",
        "An adapter artifact path is absolute and outside the portable artifact contract.",
        "Return repository-relative artifact references.",
      );
    const resolved = resolve(root, artifact);
    if (relative(root, resolved).startsWith(".."))
      return problem(
        "artifact-boundary-violation",
        "An adapter artifact escapes the repository boundary.",
        "Keep artifacts inside the declared repository/artifact root.",
      );
    const linkInfo = await lstat(resolved).catch(() => undefined);
    if (linkInfo?.isSymbolicLink())
      return problem(
        "artifact-invalid",
        "An adapter artifact is a symlink and cannot be treated as immutable evidence.",
        "Return a regular file below the repository artifact boundary.",
      );
    const actual = await realpath(resolved).catch(() => undefined);
    const relativeActual = actual === undefined ? undefined : relative(realRoot, actual);
    if (
      actual === undefined ||
      relativeActual === undefined ||
      relativeActual.startsWith("..") ||
      isAbsolute(relativeActual)
    )
      return problem(
        "artifact-boundary-violation",
        "An adapter artifact resolves outside the repository boundary or does not exist.",
        "Keep artifacts inside the declared repository/artifact root.",
      );
    const info = await stat(actual).catch(() => undefined);
    if (linkInfo === undefined || info === undefined || !info.isFile())
      return problem(
        "artifact-invalid",
        "An adapter artifact is not a regular file or is a symlink.",
        "Return regular files below the repository artifact boundary.",
      );
    if (info.size > maxArtifactBytes)
      return problem(
        "artifact-too-large",
        "An adapter artifact exceeds its declared size limit.",
        "Reduce the artifact or increase the manifest limit deliberately.",
      );
  }
  return undefined;
}

function checkFindingLocations(result: AdapterResultV1, root: string): ProblemV1 | undefined {
  for (const finding of result.findings) {
    const normalized = portablePath(finding.location.path);
    if (isAbsolute(finding.location.path) || normalized === ".." || normalized.startsWith("../"))
      return problem(
        "finding-boundary-violation",
        "An adapter finding location escapes the repository boundary.",
        "Return repository-relative finding locations.",
      );
    if (!isWithinRoot(root, resolve(root, finding.location.path)))
      return problem(
        "finding-boundary-violation",
        "An adapter finding location escapes the repository boundary.",
        "Return repository-relative finding locations.",
      );
  }
  return undefined;
}

function failedAdapter(
  requestId: string,
  state: AdapterResultV1["state"],
  message: string,
  requestDigest?: string,
): AdapterResultV1 {
  return {
    schemaVersion: "footgun.adapter-result.v1",
    requestId,
    state,
    findings: [],
    coverage: [],
    diagnostics: [
      {
        schemaVersion: "footgun.problem.v1",
        code: "adapter-run-failed",
        message,
        recovery: "Inspect the adapter diagnostics and rerun with a bounded workload.",
      },
    ],
    rawArtifacts: [],
    rawArtifactDigests: {},
    ...(requestDigest === undefined ? {} : {requestDigest}),
  };
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}
