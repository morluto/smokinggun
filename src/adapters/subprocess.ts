import {isAbsolute, relative, resolve} from "node:path";
import {constants} from "node:fs";
import {lstat, open, realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execa} from "execa";
import {
  Protocol,
  type AdapterManifestV1,
  type AdapterRequestV1,
  type AdapterResultV2,
  type ProblemV1,
} from "../protocol/index.js";
import {executionEnvironment, redactCommand, redactSensitive} from "./environment.js";
import {isWithinRoot, portablePath} from "../paths.js";
import {stableJson} from "../serialization.js";
import {sandboxAdapterCommand} from "./sandbox.js";

export type AdapterRunOptions = {
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly retainArtifact?: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<{readonly reference: string; readonly digest: string}>;
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
): Promise<AdapterResultV2 | ProblemV1> {
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
  return runParsedSubprocessAdapter(manifest.data, request.data, options);
}

/** Run an adapter whose manifest and request have already crossed their schema boundaries. */
export async function runParsedSubprocessAdapter(
  manifest: AdapterManifestV1,
  request: AdapterRequestV1,
  options: AdapterRunOptions,
): Promise<AdapterResultV2 | ProblemV1> {
  const command = manifest.command;
  const sandboxed = await sandboxAdapterCommand(command, options.root);
  if ("schemaVersion" in sandboxed) return sandboxed;
  const identity = {
    id: manifest.id,
    version: manifest.version,
    command: redactCommand(manifest.command, options.root),
  };
  const requestDigest = createHash("sha256").update(stableJson(request)).digest("hex");
  const failure = (state: AdapterResultV2["state"], message: string): AdapterResultV2 => ({
    ...failedAdapter(request.requestId, state, message, requestDigest),
    adapter: identity,
    ...(request.configDigest === undefined ? {} : {configDigest: request.configDigest}),
    ...(request.sourceDigest === undefined ? {} : {sourceDigest: request.sourceDigest}),
  });
  try {
    const result = await execa(sandboxed.executable, sandboxed.arguments, {
      cwd: options.root,
      input: JSON.stringify(request),
      timeout: manifest.limits.timeoutMs,
      forceKillAfterDelay: 250,
      cleanup: true,
      windowsHide: false,
      maxBuffer: manifest.limits.maxOutputBytes,
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
        "The adapter result does not satisfy AdapterResultV2.",
        "Update the adapter to the supported protocol version.",
      );
    if (parsed.data.requestId !== request.requestId)
      return problem(
        "adapter-request-mismatch",
        "The adapter result requestId does not match the request.",
        "Run the adapter once per request and preserve requestId.",
      );
    const artifacts = await captureArtifacts(parsed.data, options.root, manifest.limits.maxArtifactBytes, options);
    if ("schemaVersion" in artifacts) return artifacts;
    const findingBoundaryProblem = checkFindingLocations(parsed.data, options.root, request.targets);
    if (findingBoundaryProblem !== undefined) return findingBoundaryProblem;
    const coverageBoundaryProblem = checkCoverageScope(parsed.data, request.targets);
    if (coverageBoundaryProblem !== undefined) return coverageBoundaryProblem;
    if (result.exitCode !== 0 && parsed.data.state === "complete")
      return failure("failed", "The adapter exited nonzero while claiming complete output.");
    const stderr = redactSensitive(result.stderr.trim()).slice(0, 8_192);
    return {
      ...normalizeAdapterEvidence(
        {...parsed.data, rawArtifacts: [...artifacts.references], rawArtifactDigests: artifacts.digests},
        manifest,
        request.targets,
      ),
      requestDigest,
      ...(request.configDigest === undefined ? {} : {configDigest: request.configDigest}),
      ...(request.sourceDigest === undefined ? {} : {sourceDigest: request.sourceDigest}),
      ...(stderr.length === 0
        ? {}
        : {
            diagnostics: [
              ...parsed.data.diagnostics,
              {
                schemaVersion: "smokinggun.problem.v1" as const,
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

async function captureArtifacts(
  result: AdapterResultV2,
  root: string,
  maxArtifactBytes: number,
  options: AdapterRunOptions,
): Promise<
  {readonly references: ReadonlyArray<string>; readonly digests: Readonly<Record<string, string>>} | ProblemV1
> {
  if (result.rawArtifacts.length > 0 && options.retainArtifact === undefined)
    return problem(
      "adapter-artifact-retention-unavailable",
      "The adapter returned artifacts but no content-addressed retention boundary was provided.",
      "Run through a host that can retain exact artifact bytes, or return no raw artifacts.",
    );
  const realRoot = await realpath(root).catch(() => resolve(root));
  const references: string[] = [];
  const digests: Record<string, string> = {};
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
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
      () => undefined,
    );
    if (handle === undefined)
      return problem(
        "artifact-invalid",
        "An adapter artifact is not a regular file or is a symlink.",
        "Return regular files below the repository artifact boundary.",
      );
    try {
      if ((await lstat(resolved)).isSymbolicLink())
        return problem(
          "artifact-invalid",
          "An adapter artifact is not a regular file or is a symlink.",
          "Return regular files below the repository artifact boundary.",
        );
      const info = await handle.stat();
      if (!info.isFile())
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
      const declaredDigest = result.rawArtifactDigests[artifact];
      if (declaredDigest === undefined)
        return problem(
          "artifact-digest-required",
          "An adapter artifact has no exact SHA-256 digest.",
          "Hash every artifact's exact bytes before returning the result.",
        );
      const bytes = await handle.readFile();
      if (bytes.byteLength > maxArtifactBytes)
        return problem(
          "artifact-too-large",
          "An adapter artifact exceeds its declared size limit.",
          "Reduce the artifact or increase the manifest limit deliberately.",
        );
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      if (actualDigest !== declaredDigest)
        return problem(
          "artifact-digest-mismatch",
          "An adapter artifact does not match its declared SHA-256 digest.",
          "Regenerate the artifact and return its exact digest.",
        );
      const stored = await options.retainArtifact?.(artifact, bytes);
      if (stored === undefined || stored.digest !== actualDigest)
        return problem(
          "artifact-retention-failed",
          "The host artifact store did not preserve the adapter's exact bytes.",
          "Repair the content-addressed artifact store before accepting adapter evidence.",
        );
      references.push(stored.reference);
      digests[stored.reference] = stored.digest;
    } finally {
      await handle.close();
    }
  }
  return {references: [...new Set(references)].sort(), digests};
}

function checkFindingLocations(
  result: AdapterResultV2,
  root: string,
  targets: ReadonlyArray<string>,
): ProblemV1 | undefined {
  const targetSet = new Set(targets.map(portablePath));
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
    if (!targetSet.has(normalized))
      return problem(
        "finding-scope-violation",
        "An adapter finding is outside the exact requested target set.",
        "Return findings only for request.targets; model dependency expansion explicitly before execution.",
      );
  }
  return undefined;
}

function checkCoverageScope(result: AdapterResultV2, targets: ReadonlyArray<string>): ProblemV1 | undefined {
  const targetSet = new Set(targets.map(portablePath));
  const analyzedTargets = new Set(result.analyzedTargets.map(portablePath));
  for (const analyzed of analyzedTargets)
    if (!targetSet.has(analyzed))
      return problem(
        "coverage-scope-violation",
        "Adapter receipts name an analyzed file outside the exact requested target set.",
        "Return analyzedTargets only from request.targets.",
      );
  if (
    result.state === "complete" &&
    (analyzedTargets.size !== targetSet.size || [...targetSet].some((target) => !analyzedTargets.has(target)))
  )
    return problem(
      "adapter-complete-receipts-missing",
      "Complete adapter evidence requires an exact receipt for every requested target.",
      "Return analyzedTargets containing every request target exactly once, or return partial coverage.",
    );
  for (const record of result.coverage)
    for (const skipped of record.skippedFiles)
      if (!targetSet.has(portablePath(skipped)))
        return problem(
          "coverage-scope-violation",
          "Adapter coverage names a file outside the exact requested target set.",
          "Report skipped files only from request.targets.",
        );
  return undefined;
}

function normalizeAdapterEvidence(
  result: AdapterResultV2,
  manifest: AdapterManifestV1,
  targets: ReadonlyArray<string>,
): AdapterResultV2 {
  const scanner = `smokinggun.adapter:${manifest.id}`;
  const acceptedFindings = result.state === "complete" || result.state === "partial" ? result.findings : [];
  const ids = new Map(
    acceptedFindings.map((finding) => {
      const {
        id: _id,
        scanner: _scanner,
        scannerVersion: _scannerVersion,
        relatedFindings: _related,
        ...claim
      } = finding;
      const digest = createHash("sha256")
        .update(stableJson({scanner, version: manifest.version, claim}))
        .digest("hex")
        .slice(0, 16);
      return [finding.id, `sg_${digest}`] as const;
    }),
  );
  const findings = acceptedFindings.map((finding) => ({
    ...finding,
    id: ids.get(finding.id) ?? finding.id,
    scanner,
    scannerVersion: manifest.version,
    relatedFindings: finding.relatedFindings.flatMap((id) => {
      const normalized = ids.get(id);
      return normalized === undefined ? [] : [normalized];
    }),
    thirdParty: {
      ...finding.thirdParty,
      adapterClaimedScanner: finding.scanner,
      adapterClaimedScannerVersion: finding.scannerVersion,
    },
  }));
  const normalizedTargets = [...new Set(targets.map(portablePath))].sort();
  const analyzedTargets = [...new Set(result.analyzedTargets.map(portablePath))].sort();
  const language = manifest.languages.length === 1 ? (manifest.languages[0] ?? "mixed") : "mixed";
  if (result.state === "complete")
    return {
      ...result,
      findings,
      coverage: [
        {
          scanner,
          version: manifest.version,
          language,
          filesDiscovered: normalizedTargets.length,
          filesAnalyzed: analyzedTargets.length,
          parseStatus: "complete",
          skippedFiles: [],
        },
      ],
    };
  if (result.state === "partial") {
    const analyzedSet = new Set(analyzedTargets);
    const skippedFiles = normalizedTargets.filter((target) => !analyzedSet.has(target));
    return {
      ...result,
      findings,
      coverage: [
        {
          scanner,
          version: manifest.version,
          language,
          filesDiscovered: normalizedTargets.length,
          filesAnalyzed: analyzedTargets.length,
          parseStatus: "partial",
          skippedFiles,
          reason: "The host normalized partial adapter coverage against the requested target set.",
        },
      ],
    };
  }
  return {
    ...result,
    findings: [],
    coverage: [
      {
        scanner,
        version: manifest.version,
        language,
        filesDiscovered: normalizedTargets.length,
        filesAnalyzed: 0,
        parseStatus: "unavailable",
        skippedFiles: normalizedTargets,
        reason: `The adapter returned state ${result.state}.`,
      },
    ],
  };
}

function failedAdapter(
  requestId: string,
  state: AdapterResultV2["state"],
  message: string,
  requestDigest?: string,
): AdapterResultV2 {
  return {
    schemaVersion: "smokinggun.adapter-result.v2",
    requestId,
    state,
    findings: [],
    coverage: [],
    analyzedTargets: [],
    diagnostics: [
      {
        schemaVersion: "smokinggun.problem.v1",
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
  return {schemaVersion: "smokinggun.problem.v1", code, message, recovery};
}
