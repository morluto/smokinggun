import {lstat, readdir, stat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {relative, resolve} from "node:path";
import {execa} from "execa";
import type {CoverageRecordV1, FindingV2, ProblemV1, ScanReportV2} from "../protocol/index.js";
import {grammarLanguageForPath, parseWithTreeSitter} from "../parsers/tree-sitter-runtime.js";
import {scanWithTreeSitter} from "../scanners/tree-sitter-structural.js";
import {
  scanPythonSemantic,
  pythonSemanticScannerId,
  pythonSemanticScannerVersion,
} from "../scanners/python-semantic.js";
import {isSupportedExtension, scannerId, scannerVersion} from "../scanners/structural-finding.js";
import {scanTypeScriptSnapshot, semanticScannerId, semanticScannerVersion} from "../scanners/typescript-semantic.js";
import {comparePortable, portablePath} from "../paths.js";
import {buildRepositoryInventory} from "./inventory.js";
import type {AdapterExecutionAuthorization, ParsedExternalAdapters} from "../scanners/external.js";
import {toolIdentity} from "../tool-identity.js";
import {stableJson} from "../serialization.js";
import {
  explicitlyRequiresScanner,
  hasUnmatchedExplicitScope,
  matchesScanScope,
  runsAdapter,
  runsBuiltInScanner,
  type ScanScope,
  type ScannerSelection,
} from "./selection.js";
import {
  captureSourceSnapshot,
  defaultSourceCaptureLimits,
  type SourceCaptureLimits,
  type UnavailableSourceFile,
} from "./source-snapshot.js";
import {withSourceSnapshotView} from "./snapshot-view.js";
import {runParsedSubprocessAdapter} from "../adapters/subprocess.js";

type CoverageDetails = Pick<
  CoverageRecordV1,
  "scanner" | "version" | "language" | "filesDiscovered" | "filesAnalyzed" | "skippedFiles"
>;

function coverageRecord(
  details: CoverageDetails,
  parseStatus: CoverageRecordV1["parseStatus"],
  reason?: string,
): CoverageRecordV1 {
  if (parseStatus === "complete") return {...details, parseStatus, ...(reason === undefined ? {} : {reason})};
  return {
    ...details,
    parseStatus,
    reason: reason ?? "The scanner reported incomplete coverage without a specific reason.",
  };
}

const defaultExcludes = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
]);

export type ScanOptions = {
  readonly configDigest: string;
  readonly selection: ScannerSelection;
  readonly scope: ScanScope;
  readonly excludes?: ReadonlyArray<string>;
  readonly maxFindings?: number;
  readonly signal?: AbortSignal;
  readonly adapters: ParsedExternalAdapters;
  readonly adapterAuthorization: AdapterExecutionAuthorization;
  readonly sourceCaptureLimits?: SourceCaptureLimits;
  readonly retainAdapterArtifact?: (
    path: string,
    bytes: Uint8Array,
  ) => Promise<{readonly reference: string; readonly digest: string}>;
};

export type ScanRepositoryResult = {
  readonly report: ScanReportV2;
  readonly policyFindings: ReadonlyArray<FindingV2>;
};

/** Scan one local repository without executing source code or contacting the network. */
export async function scanRepository(inputRoot: string, options: ScanOptions): Promise<ScanRepositoryResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const root = resolve(inputRoot);
  if ((await lstat(root)).isSymbolicLink()) throw new Error("The scan root cannot be a symlink.");
  const rootInfo = await stat(root);
  const pathRoot = rootInfo.isDirectory() ? root : resolve(root, "..");
  const excludes = new Set([...defaultExcludes, ...(options.excludes ?? [])]);
  const sourceCaptureLimits = options.sourceCaptureLimits ?? defaultSourceCaptureLimits;
  const discovered = await collectFiles(root, excludes, sourceCaptureLimits, options.signal);
  const inScope = (path: string): boolean => matchesScanScope(options.scope, portablePath(relative(pathRoot, path)));
  const files = discovered.files.filter(inScope);
  const sourceSnapshot = await captureSourceSnapshot(
    pathRoot,
    files,
    sourceCaptureLimits,
    options.signal === undefined ? {} : {signal: options.signal},
  );
  const capturedSources = new Map(sourceSnapshot.capturedFiles.map((file) => [file.path, file]));
  const unavailableSources = new Map(
    sourceSnapshot.files.flatMap((file) => (file._tag === "unavailable" ? [[file.path, file] as const] : [])),
  );
  const skippedSourceSymlinks = discovered.sourceSymlinks.filter(inScope);
  const skippedDirectorySymlinks = discovered.directorySymlinks.filter(inScope);
  const runStructural = runsBuiltInScanner(options.selection, "structural");
  const runTypeScript = runsBuiltInScanner(options.selection, "typescript-semantic");
  const runPython = runsBuiltInScanner(options.selection, "python-semantic");
  const selectedTypeScriptFiles = runTypeScript ? files.filter(isTypeScriptPath) : [];
  const selectedPythonFiles = runPython ? files.filter((file) => extensionOf(file).toLowerCase() === ".py") : [];
  const findings: FindingV2[] = [];
  const skippedFiles: string[] = [];
  let analyzed = 0;
  let partial = false;
  let partialReason: string | undefined;
  const parseDiagnostics: ProblemV1[] = [];
  const analyzedFiles: string[] = [];
  const parserCoverage = new Map<
    string,
    {
      discovered: number;
      analyzed: number;
      partial: number;
      unavailable: number;
      skipped: string[];
      reasons: Set<string>;
    }
  >();
  const parserEntryFor = (language: string) => {
    const entry = parserCoverage.get(language) ?? {
      discovered: 0,
      analyzed: 0,
      partial: 0,
      unavailable: 0,
      skipped: [],
      reasons: new Set<string>(),
    };
    parserCoverage.set(language, entry);
    return entry;
  };
  const typeScriptSemanticSkipped: string[] = [];
  const pythonSemanticSkipped: string[] = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    const reportPath = portablePath(relative(pathRoot, file));
    const captured = capturedSources.get(reportPath);
    if (captured === undefined) {
      skippedFiles.push(reportPath);
      if (runStructural) {
        const language = grammarLanguageForPath(file);
        if (language !== undefined) {
          const parserEntry = parserEntryFor(language);
          parserEntry.discovered += 1;
          parserEntry.unavailable += 1;
          parserEntry.skipped.push(reportPath);
          parserEntry.reasons.add("One or more selected source files could not be read.");
        }
      }
      if (runTypeScript && isTypeScriptPath(file)) typeScriptSemanticSkipped.push(reportPath);
      if (runPython && extensionOf(file).toLowerCase() === ".py") pythonSemanticSkipped.push(reportPath);
      continue;
    }
    const source = captured.text;
    analyzed += 1;
    analyzedFiles.push(file);
    const treeStructural = runStructural ? await scanWithTreeSitter(reportPath, source, options.signal) : undefined;
    const result = {
      findings: treeStructural?.findings ?? [],
      parseStatus:
        treeStructural === undefined || treeStructural.coverage.status === "complete"
          ? ("complete" as const)
          : ("partial" as const),
      ...(treeStructural?.coverage.status === "complete" || treeStructural === undefined
        ? {}
        : {reason: treeStructural.coverage.error}),
    };
    findings.push(...result.findings);
    if (result.parseStatus === "partial") {
      partial = true;
      partialReason = result.reason;
      parseDiagnostics.push({
        schemaVersion: "smokinggun.problem.v1",
        code: "partial-parse",
        message: `Structural coverage is partial for ${reportPath}.`,
        path: reportPath,
        detail: result.reason,
        recovery: "Inspect the file manually or rerun after fixing the syntax.",
      });
    }
    if (runStructural) {
      const parserResult = treeStructural?.coverage ?? (await parseWithTreeSitter(reportPath, source, options.signal));
      const parserEntry = parserEntryFor(parserResult.language);
      parserEntry.discovered += 1;
      if (parserResult.status === "complete") parserEntry.analyzed += 1;
      if (parserResult.status === "partial") {
        parserEntry.partial += 1;
        partial = true;
      }
      if (parserResult.status === "unavailable") {
        parserEntry.unavailable += 1;
        partial = true;
      }
      if (parserResult.status !== "complete") {
        parserEntry.reasons.add(parserResult.error);
        parseDiagnostics.push({
          schemaVersion: "smokinggun.problem.v1",
          code: parserResult.status === "unavailable" ? "parser-unavailable" : "partial-parse",
          message: `Tree-sitter coverage is ${parserResult.status} for ${reportPath}.`,
          path: reportPath,
          detail: parserResult.error,
          recovery: "Inspect the file manually or verify the pinned grammar asset.",
        });
      }
      parserCoverage.set(parserResult.language, parserEntry);
    }
  }
  const semanticSources = selectedTypeScriptFiles.flatMap((file) => {
    const path = portablePath(relative(pathRoot, file));
    const captured = capturedSources.get(path);
    return captured === undefined ? [] : [{path, text: captured.text}];
  });
  const semantic = runTypeScript
    ? await scanTypeScriptSnapshot(pathRoot, semanticSources, options.signal)
    : {state: "unavailable" as const, diagnostics: [], findings: []};
  findings.push(...semantic.findings);
  parseDiagnostics.push(...semantic.diagnostics);
  const pythonResults = [];
  if (runPython)
    for (const file of selectedPythonFiles) {
      const path = portablePath(relative(pathRoot, file));
      const captured = capturedSources.get(path);
      if (captured === undefined) continue;
      const result = await scanPythonSemantic(path, captured.text, options.signal);
      pythonResults.push(result);
      findings.push(...result.findings);
      parseDiagnostics.push(...result.diagnostics);
    }
  const semanticSkippedFiles = [...new Set(typeScriptSemanticSkipped)].sort(comparePortable);
  const semanticReasons = [
    ...semantic.diagnostics.map((diagnostic) => diagnostic.message),
    ...(discovered.traversalLimit === undefined ? [] : [discovered.traversalLimit]),
    ...(typeScriptSemanticSkipped.length === 0
      ? []
      : ["One or more selected TypeScript source files could not be read."]),
  ];
  const repository = await repositoryIdentity(root, files, options.signal);
  const inventory = await buildRepositoryInventory(pathRoot, files, [...excludes]);
  const sourceDigest = sourceSnapshot.digest;
  const adapterRun = await runConfiguredAdapters(options.adapters, sourceSnapshot, options);
  findings.push(...adapterRun.findings);
  parseDiagnostics.push(...adapterRun.diagnostics);
  parseDiagnostics.push(...scannerDisagreements(findings));
  const policyFindings = relateFindings(findings).sort(compareFindings);
  const allFindings = pruneFindingRelations(selectRepresentativeFindings(policyFindings, options.maxFindings ?? 80));
  const scopeMatchedNothing =
    discovered.traversalLimit === undefined &&
    hasUnmatchedExplicitScope(
      options.scope,
      files.length + skippedSourceSymlinks.length + skippedDirectorySymlinks.length,
    );
  const skippedSymlinkPaths = [...skippedSourceSymlinks, ...skippedDirectorySymlinks];
  const coverage: CoverageRecordV1 | undefined = runStructural
    ? coverageRecord(
        {
          scanner: scannerId,
          version: scannerVersion,
          language: "mixed",
          filesDiscovered: files.length + skippedSourceSymlinks.length,
          filesAnalyzed: analyzed,
          skippedFiles: [
            ...skippedFiles,
            ...skippedSymlinkPaths.map((file) => portablePath(relative(pathRoot, file))),
          ].sort(comparePortable),
        },
        scopeMatchedNothing ||
          discovered.traversalLimit !== undefined ||
          skippedFiles.length > 0 ||
          skippedSymlinkPaths.length > 0 ||
          partial
          ? "partial"
          : files.length > 0 && analyzed === 0
            ? "unavailable"
            : "complete",
        partialReason ??
          (discovered.traversalLimit !== undefined
            ? discovered.traversalLimit
            : scopeMatchedNothing
              ? "The explicit --only filter matched no supported source paths."
              : skippedFiles.length > 0
                ? "One or more selected source files could not be read."
                : skippedSymlinkPaths.length > 0
                  ? "Symlinks were skipped to preserve the repository boundary."
                  : undefined),
      )
    : undefined;
  const diagnostics: ProblemV1[] = [
    ...parseDiagnostics,
    ...(discovered.traversalLimit === undefined
      ? []
      : [
          {
            schemaVersion: "smokinggun.problem.v1" as const,
            code: "source-traversal-bounded",
            message: "Source discovery stopped at a configured traversal bound.",
            detail: discovered.traversalLimit,
            recovery: "Narrow the scan scope or deliberately raise the source capture limits.",
          },
        ]),
    ...(scopeMatchedNothing
      ? [
          {
            schemaVersion: "smokinggun.problem.v1" as const,
            code: "scan-scope-unmatched",
            message: "The explicit --only filter matched no supported source paths.",
            recovery: "Use a scan-root-relative path or a supported language or extension filter.",
          },
        ]
      : []),
    ...skippedFiles.map((path): ProblemV1 => ({
      schemaVersion: "smokinggun.problem.v1",
      code: "source-capture-incomplete",
      message: `Skipped ${path} because immutable source capture was incomplete.`,
      path,
      detail: sourceCaptureReason(unavailableSources.get(path)),
      recovery: "Check source capture bounds, encoding, file type, and permissions before rerunning the scan.",
    })),
    ...skippedSymlinkPaths.map((path): ProblemV1 => ({
      schemaVersion: "smokinggun.problem.v1",
      code: "symlink-skipped",
      message: `Skipped symlink ${portablePath(relative(pathRoot, path))}.`,
      path: portablePath(relative(pathRoot, path)),
      recovery: "Replace the symlink with content inside the scan root before scanning.",
    })),
    ...(allFindings.length === policyFindings.length
      ? []
      : [
          {
            schemaVersion: "smokinggun.problem.v1" as const,
            code: "findings-truncated",
            message: `Emitted ${allFindings.length} of ${policyFindings.length} findings due to the configured limit.`,
            recovery: "Increase maxFindings to review the remaining findings.",
          },
        ]),
  ];
  const parserRecords = [...parserCoverage.entries()]
    .sort(([left], [right]) => comparePortable(left, right))
    .map(([language, entry]): CoverageRecordV1 => {
      const parserSkippedFiles = [
        ...entry.skipped,
        ...skippedSourceSymlinks
          .filter((file) => sourceLanguage(file) === language)
          .map((file) => portablePath(relative(pathRoot, file))),
      ].sort(comparePortable);
      return coverageRecord(
        {
          scanner: "smokinggun.tree-sitter",
          version: "0.26.11",
          language,
          filesDiscovered:
            entry.discovered + skippedSourceSymlinks.filter((file) => sourceLanguage(file) === language).length,
          filesAnalyzed: entry.analyzed,
          skippedFiles: parserSkippedFiles,
        },
        entry.unavailable > 0
          ? "unavailable"
          : scopeMatchedNothing ||
              discovered.traversalLimit !== undefined ||
              entry.partial > 0 ||
              parserSkippedFiles.length > 0
            ? "partial"
            : "complete",
        entry.reasons.size === 0 ? discovered.traversalLimit : [...entry.reasons].sort(comparePortable).join(" "),
      );
    });
  const semanticCoverage: CoverageRecordV1 | undefined =
    runTypeScript &&
    (analyzedFiles.some((file) => isTypeScriptPath(file)) ||
      explicitlyRequiresScanner(options.selection, "typescript-semantic"))
      ? coverageRecord(
          {
            scanner: semanticScannerId,
            version: semanticScannerVersion,
            language: "typescript-javascript",
            filesDiscovered: selectedTypeScriptFiles.length,
            filesAnalyzed: semantic.state === "unavailable" ? 0 : semanticSources.length,
            skippedFiles: semanticSkippedFiles,
          },
          semantic.state === "unavailable"
            ? "unavailable"
            : scopeMatchedNothing ||
                discovered.traversalLimit !== undefined ||
                semantic.state === "partial" ||
                semanticSkippedFiles.length > 0
              ? "partial"
              : "complete",
          semanticReasons.length === 0 ? undefined : semanticReasons.join(" "),
        )
      : undefined;
  const pythonCoverage: CoverageRecordV1 | undefined =
    !runPython || (selectedPythonFiles.length === 0 && !explicitlyRequiresScanner(options.selection, "python-semantic"))
      ? undefined
      : coverageRecord(
          {
            scanner: pythonSemanticScannerId,
            version: pythonSemanticScannerVersion,
            language: "python",
            filesDiscovered: selectedPythonFiles.length,
            filesAnalyzed: pythonResults.length,
            skippedFiles: [...pythonSemanticSkipped].sort(comparePortable),
          },
          (selectedPythonFiles.length > 0 && pythonResults.length === 0) ||
            pythonResults.some((result) => result.coverage.status === "unavailable")
            ? "unavailable"
            : discovered.traversalLimit !== undefined ||
                scopeMatchedNothing ||
                pythonSemanticSkipped.length > 0 ||
                pythonResults.some((result) => result.coverage.status === "partial")
              ? "partial"
              : "complete",
          discovered.traversalLimit ??
            (scopeMatchedNothing
              ? "The explicit --only filter matched no supported Python source paths."
              : pythonSemanticSkipped.length > 0
                ? "One or more selected Python source files could not be captured."
                : pythonResults
                    .flatMap((result) => (result.coverage.status === "complete" ? [] : [result.coverage.error]))
                    .join(" ") || undefined),
        );
  const coverageRecords = [
    ...(coverage === undefined ? [] : [coverage]),
    ...parserRecords,
    ...(semanticCoverage === undefined ? [] : [semanticCoverage]),
    ...(pythonCoverage === undefined ? [] : [pythonCoverage]),
    ...adapterRun.coverage,
  ];
  const resolvedCoverage = resolveCoverageIdentityCollisions(coverageRecords);
  const report: ScanReportV2 = {
    schemaVersion: "smokinggun.scan-report.v2",
    tool: toolIdentity,
    repository,
    inventory,
    sourceDigest,
    configDigest: options.configDigest,
    findings: allFindings,
    coverage: resolvedCoverage.records,
    diagnostics: [...diagnostics, ...resolvedCoverage.diagnostics],
    timings: {startedAt, durationMs: Math.max(0, performance.now() - started)},
    assumptions: [
      "Structural findings are candidates; type, caller, workload, and runtime evidence were not inferred.",
      "Structural rule coverage is limited to syntax-backed nested-loop and in-loop membership, sort, and transform rules; fallback-only recursion, I/O, and render rules are disabled.",
    ],
    nextAction:
      allFindings.length === 0
        ? "Review coverage and unknowns before concluding that no optimization candidate exists."
        : "Inspect the first candidate from each represented repository area; ordering is deterministic, not runtime importance.",
    filesModified: [],
    rawArtifacts: [...adapterRun.rawArtifacts],
    ...(Object.keys(adapterRun.rawArtifactDigests).length === 0
      ? {}
      : {rawArtifactDigests: adapterRun.rawArtifactDigests}),
  };
  return {report, policyFindings};
}

async function runConfiguredAdapters(
  parsed: ParsedExternalAdapters,
  snapshot: Awaited<ReturnType<typeof captureSourceSnapshot>>,
  options: ScanOptions,
): Promise<{
  readonly findings: ReadonlyArray<FindingV2>;
  readonly coverage: ReadonlyArray<CoverageRecordV1>;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
  readonly rawArtifacts: ReadonlyArray<string>;
  readonly rawArtifactDigests: Readonly<Record<string, string>>;
}> {
  if (parsed.adapters.length === 0 && parsed.invalidDescriptors.length === 0 && parsed.diagnostics.length === 0)
    return {
      findings: [],
      coverage: [],
      diagnostics: [],
      rawArtifacts: [],
      rawArtifactDigests: {},
    };
  const selectedAdapters = selectExternalAdapters(parsed, options.selection);
  if (
    selectedAdapters.adapters.length === 0 &&
    selectedAdapters.invalidDescriptors.length === 0 &&
    selectedAdapters.diagnostics.length === 0
  )
    return {
      findings: [],
      coverage: [],
      diagnostics: [],
      rawArtifacts: [],
      rawArtifactDigests: {},
    };
  const findings: FindingV2[] = [];
  const coverage: CoverageRecordV1[] = [];
  const diagnostics: ProblemV1[] = [...selectedAdapters.diagnostics];
  const rawArtifacts: string[] = [];
  const rawArtifactDigests: Record<string, string> = {};
  const sourceTargets = snapshot.capturedFiles.map((file) => file.path).sort(comparePortable);
  const unavailableTargets = snapshot.files
    .flatMap((file) => (file._tag === "unavailable" ? [file.path] : []))
    .sort(comparePortable);
  const invalidCoverageIdentities = new Set<string>();
  for (const descriptor of selectedAdapters.invalidDescriptors) {
    const scanner = `smokinggun.adapter:${descriptor.id}`;
    const identity = `${scanner}\0${descriptor.version}\0mixed`;
    if (invalidCoverageIdentities.has(identity)) continue;
    invalidCoverageIdentities.add(identity);
    coverage.push({
      scanner,
      version: descriptor.version,
      language: "mixed",
      filesDiscovered: snapshot.requestedFileCount,
      filesAnalyzed: 0,
      parseStatus: "unavailable",
      skippedFiles: sourceTargets,
      reason: descriptor.availability === "invalid" ? descriptor.reason : "Adapter manifest validation failed.",
    });
  }
  const runAdapters = async (snapshotRoot: string): Promise<void> => {
    for (const adapter of selectedAdapters.adapters) {
      if (!runsAdapter(options.selection, adapter.manifest.id)) continue;
      const language = adapter.manifest.languages.length === 1 ? (adapter.manifest.languages[0] ?? "mixed") : "mixed";
      const unavailable = (code: string, message: string, recovery: string): void => {
        diagnostics.push({schemaVersion: "smokinggun.problem.v1", code, message, recovery});
        coverage.push({
          scanner: `smokinggun.adapter:${adapter.manifest.id}`,
          version: adapter.manifest.version,
          language,
          filesDiscovered: snapshot.requestedFileCount,
          filesAnalyzed: 0,
          parseStatus: "unavailable",
          skippedFiles: sourceTargets,
          reason: message,
        });
      };
      if (!adapter.manifest.capabilities.includes("static-scan")) {
        unavailable(
          "adapter-capability-mismatch",
          `Adapter ${adapter.manifest.id} does not declare the requested static-scan capability.`,
          "Use an adapter whose manifest supports static-scan.",
        );
        continue;
      }
      if (options.adapterAuthorization._tag !== "AdapterExecutionAuthorized") {
        unavailable(
          "adapter-execution-required",
          `Adapter ${adapter.manifest.id} was not executed because explicit authorization is missing.`,
          "Rerun with --allow-adapter-execution.",
        );
        continue;
      }
      if (adapter.manifest.sideEffects.includes("network")) {
        unavailable(
          "adapter-network-blocked",
          `Adapter ${adapter.manifest.id} requests network access during an offline static scan.`,
          "Use an offline adapter with no network side effect.",
        );
        continue;
      }
      const request = {
        schemaVersion: "smokinggun.adapter-request.v1" as const,
        requestId: `req_${createHash("sha256").update(`${snapshot.digest}\0${adapter.manifest.id}`).digest("hex").slice(0, 16)}`,
        root: ".",
        config: {scanner: adapter.manifest.id},
        operation: "scan" as const,
        targets: sourceTargets,
        revision: null,
        sourceDigest: snapshot.digest,
        configDigest: options.configDigest,
        requestedCapabilities: ["static-scan"],
        executionPolicy: {
          network: "disabled" as const,
          shell: false as const,
          maxOutputBytes: adapter.manifest.limits.maxOutputBytes,
        },
      };
      const result = await runParsedSubprocessAdapter(adapter.manifest, request, {
        root: snapshotRoot,
        ...(options.signal === undefined ? {} : {signal: options.signal}),
        ...(options.retainAdapterArtifact === undefined ? {} : {retainArtifact: options.retainAdapterArtifact}),
      });
      if ("code" in result) {
        unavailable(result.code, result.message, result.recovery ?? "Inspect the adapter diagnostic and retry.");
        continue;
      }
      findings.push(...result.findings);
      const adapterCoverage: ReadonlyArray<CoverageRecordV1> =
        result.coverage.length > 0
          ? result.coverage
          : [
              {
                scanner: `smokinggun.adapter:${adapter.manifest.id}`,
                version: adapter.manifest.version,
                language,
                filesDiscovered: snapshot.requestedFileCount,
                filesAnalyzed: 0,
                parseStatus: "unavailable",
                skippedFiles: sourceTargets,
                reason: `The adapter returned state ${result.state} without coverage.`,
              },
            ];
      coverage.push(
        ...adapterCoverage.map((record): CoverageRecordV1 =>
          unavailableTargets.length === 0
            ? record
            : {
                ...record,
                filesDiscovered: snapshot.requestedFileCount,
                parseStatus: record.parseStatus === "unavailable" ? "unavailable" : "partial",
                skippedFiles: [...new Set([...record.skippedFiles, ...unavailableTargets])].sort(comparePortable),
                reason: "One or more requested source files were absent from the immutable snapshot.",
              },
        ),
      );
      diagnostics.push(...result.diagnostics);
      rawArtifacts.push(...result.rawArtifacts);
      Object.assign(rawArtifactDigests, result.rawArtifactDigests);
    }
  };
  if (selectedAdapters.adapters.length > 0) await withSourceSnapshotView(snapshot, runAdapters);
  return {
    findings,
    coverage,
    diagnostics,
    rawArtifacts: [...new Set(rawArtifacts)].sort(comparePortable),
    rawArtifactDigests,
  };
}

function selectExternalAdapters(parsed: ParsedExternalAdapters, selection: ScannerSelection): ParsedExternalAdapters {
  if (selection._tag === "AutomaticScannerSelection") return parsed;
  return {
    adapters: parsed.adapters.filter((adapter) => runsAdapter(selection, adapter.manifest.id)),
    // Invalid manifests have no trustworthy selectable identity. Explicit
    // scanner selection therefore excludes them instead of letting unrelated
    // configuration affect focused coverage or diagnostics.
    invalidDescriptors: [],
    diagnostics: [],
  };
}

async function collectFiles(
  root: string,
  excludes: ReadonlySet<string>,
  limits: SourceCaptureLimits,
  signal?: AbortSignal,
): Promise<{
  readonly files: ReadonlyArray<string>;
  readonly sourceSymlinks: ReadonlyArray<string>;
  readonly directorySymlinks: ReadonlyArray<string>;
  readonly traversalLimit?: string;
}> {
  const files: string[] = [];
  const sourceSymlinks: string[] = [];
  const directorySymlinks: string[] = [];
  let directoriesVisited = 0;
  let traversalLimit: string | undefined;
  const rootInfo = await stat(root);
  if (rootInfo.isFile())
    return {files: isSupportedExtension(extensionOf(root)) ? [root] : [], sourceSymlinks, directorySymlinks};
  if (!rootInfo.isDirectory()) return {files, sourceSymlinks, directorySymlinks};
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (traversalLimit !== undefined) return;
    signal?.throwIfAborted();
    if (depth > limits.maxDepth) {
      traversalLimit = `Traversal exceeded the maximum depth of ${limits.maxDepth}.`;
      return;
    }
    directoriesVisited += 1;
    if (directoriesVisited > limits.maxDirectories) {
      traversalLimit = `Traversal exceeded the maximum directory count of ${limits.maxDirectories}.`;
      return;
    }
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => comparePortable(left.name, right.name));
    for (const entry of entries) {
      if (traversalLimit !== undefined) return;
      signal?.throwIfAborted();
      if (excludes.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await stat(path).catch(() => undefined);
        if (target?.isDirectory()) directorySymlinks.push(path);
        else if (isSupportedExtension(extensionOf(path))) sourceSymlinks.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && isSupportedExtension(extensionOf(path))) {
        if (files.length >= limits.maxFiles) {
          traversalLimit = `Traversal exceeded the maximum source-file count of ${limits.maxFiles}.`;
          return;
        }
        files.push(path);
      }
    }
  };
  await visit(root, 0);
  return {
    files,
    sourceSymlinks,
    directorySymlinks,
    ...(traversalLimit === undefined ? {} : {traversalLimit}),
  };
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

function sourceLanguage(path: string): string {
  const extension = extensionOf(path).toLowerCase();
  if (extension === ".py") return "python";
  if ([".ts", ".tsx"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return extension.slice(1);
}

function sourceCaptureReason(file: UnavailableSourceFile | undefined): string {
  switch (file?.reason) {
    case "file-count-limit":
      return "The scan exceeded the configured source-file count limit.";
    case "file-size-limit":
      return "The source file exceeded the configured per-file byte limit.";
    case "total-size-limit":
      return "Capturing the source file would exceed the configured cumulative byte limit.";
    case "invalid-utf8":
      return "The source bytes are not valid UTF-8 and cannot be analyzed as source text.";
    case "outside-root":
      return "The selected source path does not remain inside the scan root.";
    case "read-failed":
    case undefined:
      return "The source path could not be opened and read as a regular non-symlink file.";
  }
}

async function repositoryIdentity(
  root: string,
  analyzedFiles: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<ScanReportV2["repository"]> {
  const info = await stat(root);
  const repositoryRoot = info.isDirectory() ? root : resolve(root, "..");
  const gitOptions = {
    cwd: repositoryRoot,
    reject: false,
    timeout: 2_000,
    ...(signal === undefined ? {} : {cancelSignal: signal}),
  } as const;
  const revisionResult = await execa("git", ["-c", "core.fsmonitor=false", "rev-parse", "HEAD"], {
    ...gitOptions,
    stdin: "ignore",
  });
  const dirtyResult = await execa(
    "git",
    ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"],
    {...gitOptions, stdin: "ignore"},
  );
  const pathspec = analyzedFiles.map((file) => relative(repositoryRoot, file)).join("\0");
  const ignoredAnalyzed = await execa(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ],
    {...gitOptions, input: pathspec},
  );
  const hasGitIdentity = revisionResult.exitCode === 0 && dirtyResult.exitCode === 0 && ignoredAnalyzed.exitCode === 0;
  return {
    // Portable reports must not leak the host checkout path.
    root: ".",
    // A working-tree scan captures exact bytes but does not read from an
    // immutable Git tree, so a Git revision cannot be an authoritative input
    // identity. A future Git-tree capture mode may populate this field.
    revision: null,
    dirty: !hasGitIdentity || dirtyResult.stdout.trim().length > 0 || ignoredAnalyzed.stdout.trim().length > 0,
  };
}

function compareFindings(left: FindingV2, right: FindingV2): number {
  const severity = {high: 0, medium: 1, low: 2, info: 3};
  return (
    severity[left.severity] - severity[right.severity] ||
    comparePortable(left.location.path, right.location.path) ||
    left.location.startLine - right.location.startLine ||
    comparePortable(left.ruleId, right.ruleId) ||
    comparePortable(left.id, right.id)
  );
}

function selectRepresentativeFindings(findings: ReadonlyArray<FindingV2>, limit: number): FindingV2[] {
  if (findings.length <= limit) return [...findings];
  const groups = new Map<string, FindingV2[]>();
  for (const finding of findings) {
    const separator = finding.location.path.indexOf("/");
    const area = separator === -1 ? "." : finding.location.path.slice(0, separator);
    const group = groups.get(area) ?? [];
    group.push(finding);
    groups.set(area, group);
  }
  const orderedGroups = [...groups.values()];
  const selected: FindingV2[] = [];
  for (let offset = 0; selected.length < limit; offset += 1) {
    let found = false;
    for (const group of orderedGroups) {
      const finding = group[offset];
      if (finding === undefined) continue;
      selected.push(finding);
      found = true;
      if (selected.length === limit) break;
    }
    if (!found) break;
  }
  return selected;
}

function relateFindings(findings: ReadonlyArray<FindingV2>): FindingV2[] {
  const result: FindingV2[] = [];
  const relatedFindingIds: Array<Set<string>> = [];
  const exact = new Map<string, FindingV2>();
  const nearby = new Map<string, number[]>();
  for (const finding of findings) {
    const priorExact = exact.get(finding.id);
    if (priorExact !== undefined) {
      if (stableJson(priorExact) !== stableJson(finding))
        throw new Error(`Finding ID ${finding.id} identifies conflicting evidence.`);
      continue;
    }
    exact.set(finding.id, finding);
    const family = findingFamily(finding.ruleId);
    const key = `${family}\0${finding.location.path}`;
    const related = new Set(finding.relatedFindings);
    for (const offset of [-1, 0, 1])
      for (const index of nearby.get(`${key}\0${finding.location.startLine + offset}`) ?? []) {
        const prior = result[index];
        const priorRelated = relatedFindingIds[index];
        if (prior === undefined || priorRelated === undefined) continue;
        related.add(prior.id);
        priorRelated.add(finding.id);
      }
    result.push({...finding, relatedFindings: []});
    relatedFindingIds.push(related);
    const lineKey = `${key}\0${finding.location.startLine}`;
    const priorIndexes = nearby.get(lineKey) ?? [];
    priorIndexes.push(result.length - 1);
    nearby.set(lineKey, priorIndexes);
  }
  return result.map((finding, index) => ({
    ...finding,
    relatedFindings: [...(relatedFindingIds[index] ?? [])].sort(comparePortable),
  }));
}

function pruneFindingRelations(findings: ReadonlyArray<FindingV2>): FindingV2[] {
  const retainedIds = new Set(findings.map((finding) => finding.id));
  return findings.map((finding) => ({
    ...finding,
    relatedFindings: finding.relatedFindings.filter((id) => retainedIds.has(id)),
  }));
}

function resolveCoverageIdentityCollisions(records: ReadonlyArray<CoverageRecordV1>): {
  readonly records: CoverageRecordV1[];
  readonly diagnostics: ProblemV1[];
} {
  const grouped = new Map<string, CoverageRecordV1[]>();
  for (const record of records) {
    const identity = `${record.scanner}\0${record.version}\0${record.language}`;
    const matches = grouped.get(identity) ?? [];
    matches.push(record);
    grouped.set(identity, matches);
  }
  const resolved: CoverageRecordV1[] = [];
  const diagnostics: ProblemV1[] = [];
  for (const matches of grouped.values()) {
    const first = matches[0];
    if (first === undefined) continue;
    if (matches.length === 1) {
      resolved.push(first);
      continue;
    }
    const skippedFiles = [...new Set(matches.flatMap((record) => record.skippedFiles))].sort(comparePortable);
    const filesDiscovered = Math.max(...matches.map((record) => record.filesDiscovered));
    const filesAnalyzed = Math.min(...matches.map((record) => record.filesAnalyzed));
    const status = matches.some((record) => record.parseStatus === "failed")
      ? "failed"
      : matches.some((record) => record.parseStatus === "unavailable")
        ? "unavailable"
        : "partial";
    const reason = `Multiple coverage records claimed ${first.scanner}@${first.version} for ${first.language}.`;
    resolved.push(
      coverageRecord(
        {
          scanner: first.scanner,
          version: first.version,
          language: first.language,
          filesDiscovered,
          filesAnalyzed,
          skippedFiles,
        },
        status,
        reason,
      ),
    );
    diagnostics.push({
      schemaVersion: "smokinggun.problem.v1",
      code: "duplicate-coverage-identity",
      message: reason,
      recovery: "Configure each scanner or adapter to report a distinct coverage identity.",
    });
  }
  return {records: resolved, diagnostics};
}

function findingFamily(ruleId: string): string {
  if (/membership|collection|repeated-scan|sort-in-loop|render-derived-work/.test(ruleId)) return "collection";
  if (/query|io-or/.test(ruleId)) return "io";
  if (/loop|recursive/.test(ruleId)) return "iteration";
  return ruleId;
}

function scannerDisagreements(findings: ReadonlyArray<FindingV2>): ReadonlyArray<ProblemV1> {
  const scanners = new Map<string, Set<string>>();
  for (const finding of findings) {
    const key = `${finding.location.path}\0${finding.location.startLine}\0${finding.ruleId}`;
    const values = scanners.get(key) ?? new Set<string>();
    values.add(finding.scanner);
    scanners.set(key, values);
  }
  return [...scanners.entries()]
    .filter(([, values]) => values.size > 1)
    .sort(([left], [right]) => comparePortable(left, right))
    .map(([key, values]): ProblemV1 => {
      const [path, line, rule] = key.split("\0");
      return {
        schemaVersion: "smokinggun.problem.v1",
        code: "scanner-disagreement",
        message: `Scanners disagree or independently reported ${rule ?? "a finding"} at ${path ?? "unknown"}:${line ?? "?"}.`,
        detail: [...values].sort(comparePortable).join(", "),
        recovery: "Inspect each scanner's provenance; duplicate evidence is not independent confirmation.",
      };
    });
}

function isTypeScriptPath(path: string): boolean {
  const extension = extensionOf(path).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}
