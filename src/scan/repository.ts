import {lstat, readFile, readdir, stat} from "node:fs/promises";
import {relative, resolve} from "node:path";
import {execa} from "execa";
import type {AdapterRequestV1, CoverageRecordV1, FindingV2, ProblemV1, ScanReportV2} from "../protocol/index.js";
import {grammarLanguageForPath, parseWithTreeSitter} from "../parsers/tree-sitter-runtime.js";
import {scanWithTreeSitter} from "../scanners/tree-sitter-structural.js";
import {
  scanPythonSemantic,
  pythonSemanticScannerId,
  pythonSemanticScannerVersion,
} from "../scanners/python-semantic.js";
import {isSupportedExtension, scanSource, scannerId, scannerVersion} from "../scanners/structural.js";
import {scanTypeScript, semanticScannerId, semanticScannerVersion} from "../scanners/typescript-semantic.js";
import {comparePortable, isWithinRoot, portablePath} from "../paths.js";
import {buildRepositoryInventory} from "./inventory.js";
import {
  resolveExternalAdapters,
  type AdapterExecutionAuthorization,
  type ParsedExternalAdapters,
} from "../scanners/external.js";
import {runParsedSubprocessAdapter} from "../adapters/subprocess.js";
import {createHash} from "node:crypto";
import {toolIdentity} from "../tool-identity.js";
import {
  explicitlyRequiresScanner,
  hasUnmatchedExplicitScope,
  matchesScanScope,
  runsAdapter,
  runsBuiltInScanner,
  type ScanScope,
  type ScannerSelection,
} from "./selection.js";

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
  const discovered = await collectFiles(root, excludes, options.signal);
  const inScope = (path: string): boolean => matchesScanScope(options.scope, portablePath(relative(pathRoot, path)));
  const files = discovered.files.filter(inScope);
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
  const sourceHasher = createHash("sha256");
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
  let pythonSemanticAnalyzed = 0;
  let pythonSemanticPartial = 0;
  let pythonSemanticUnavailable = 0;
  const pythonSemanticSkipped: string[] = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      const reportPath = portablePath(relative(pathRoot, file));
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
      if (runPython && extensionOf(reportPath).toLowerCase() === ".py") {
        pythonSemanticUnavailable += 1;
        pythonSemanticSkipped.push(reportPath);
      }
      continue;
    }
    const reportPath = portablePath(relative(pathRoot, file));
    sourceHasher.update(reportPath).update("\0").update(source).update("\0");
    analyzed += 1;
    analyzedFiles.push(file);
    const treeStructural = runStructural ? await scanWithTreeSitter(reportPath, source, options.signal) : undefined;
    const fallback = runStructural ? scanSource(reportPath, source) : {findings: [], parseStatus: "complete" as const};
    const result =
      treeStructural?.coverage.status === "complete"
        ? {findings: treeStructural.findings, parseStatus: "complete" as const}
        : fallback;
    findings.push(...result.findings);
    if (result.parseStatus === "partial") {
      partial = true;
      partialReason = result.reason;
      parseDiagnostics.push({
        schemaVersion: "footgun.problem.v1",
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
          schemaVersion: "footgun.problem.v1",
          code: parserResult.status === "unavailable" ? "parser-unavailable" : "partial-parse",
          message: `Tree-sitter coverage is ${parserResult.status} for ${reportPath}.`,
          path: reportPath,
          detail: parserResult.error,
          recovery: "Inspect the file manually or verify the pinned grammar asset.",
        });
      }
      parserCoverage.set(parserResult.language, parserEntry);
    }
    if (runPython) {
      if (extensionOf(reportPath).toLowerCase() === ".py") {
        const pythonResult = await scanPythonSemantic(reportPath, source, options.signal);
        findings.push(...pythonResult.findings);
        parseDiagnostics.push(...pythonResult.diagnostics);
        if (pythonResult.coverage.status === "complete") pythonSemanticAnalyzed += 1;
        if (pythonResult.coverage.status === "partial") pythonSemanticPartial += 1;
        if (pythonResult.coverage.status === "unavailable") {
          pythonSemanticUnavailable += 1;
          pythonSemanticSkipped.push(reportPath);
        }
      }
    }
  }
  const semantic = runTypeScript
    ? await scanTypeScript(pathRoot, analyzedFiles, options.signal)
    : {state: "unavailable" as const, diagnostics: [], findings: []};
  findings.push(...semantic.findings);
  parseDiagnostics.push(...semantic.diagnostics);
  const semanticIndex = semantic.state === "unavailable" ? undefined : semantic.index;
  const semanticSkippedFiles = [
    ...new Set([...(semanticIndex?.coverage.skippedFiles ?? []), ...typeScriptSemanticSkipped]),
  ].sort(comparePortable);
  const semanticReasons = [
    ...semantic.diagnostics.map((diagnostic) => diagnostic.message),
    ...(typeScriptSemanticSkipped.length === 0
      ? []
      : ["One or more selected TypeScript source files could not be read."]),
  ];
  const repository = await repositoryIdentity(root, files);
  const inventory = await buildRepositoryInventory(pathRoot, files, [...excludes]);
  const sourceDigest = sourceHasher.digest("hex");
  const adapterRun = await runConfiguredAdapters(
    options.adapters,
    pathRoot,
    options.configDigest,
    repository.revision,
    sourceDigest,
    files,
    options.selection,
    options.adapterAuthorization,
    options.signal,
  );
  findings.push(...adapterRun.findings);
  parseDiagnostics.push(...adapterRun.diagnostics);
  parseDiagnostics.push(...scannerDisagreements(findings));
  const policyFindings = relateFindings(findings).sort(compareFindings);
  const allFindings = pruneFindingRelations(policyFindings.slice(0, options.maxFindings ?? 80));
  const scopeMatchedNothing = hasUnmatchedExplicitScope(
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
        scopeMatchedNothing || skippedFiles.length > 0 || skippedSymlinkPaths.length > 0 || partial
          ? "partial"
          : files.length > 0 && analyzed === 0
            ? "unavailable"
            : "complete",
        partialReason ??
          (scopeMatchedNothing
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
    ...(scopeMatchedNothing
      ? [
          {
            schemaVersion: "footgun.problem.v1" as const,
            code: "scan-scope-unmatched",
            message: "The explicit --only filter matched no supported source paths.",
            recovery: "Use a scan-root-relative path or a supported language or extension filter.",
          },
        ]
      : []),
    ...skippedFiles.map((path): ProblemV1 => ({
      schemaVersion: "footgun.problem.v1",
      code: "file-unavailable",
      message: `Skipped ${path} because it could not be read.`,
      path,
      recovery: "Check file permissions and rerun the scan.",
    })),
    ...skippedSymlinkPaths.map((path): ProblemV1 => ({
      schemaVersion: "footgun.problem.v1",
      code: "symlink-skipped",
      message: `Skipped symlink ${portablePath(relative(pathRoot, path))}.`,
      path: portablePath(relative(pathRoot, path)),
      recovery: "Replace the symlink with content inside the scan root before scanning.",
    })),
    ...(allFindings.length === policyFindings.length
      ? []
      : [
          {
            schemaVersion: "footgun.problem.v1" as const,
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
          scanner: "footgun.tree-sitter",
          version: "0.26.11",
          language,
          filesDiscovered:
            entry.discovered + skippedSourceSymlinks.filter((file) => sourceLanguage(file) === language).length,
          filesAnalyzed: entry.analyzed,
          skippedFiles: parserSkippedFiles,
        },
        entry.unavailable > 0
          ? "unavailable"
          : scopeMatchedNothing || entry.partial > 0 || parserSkippedFiles.length > 0
            ? "partial"
            : "complete",
        entry.reasons.size === 0 ? undefined : [...entry.reasons].sort(comparePortable).join(" "),
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
            filesAnalyzed: semanticIndex?.coverage.filesIndexed ?? 0,
            skippedFiles: semanticSkippedFiles,
          },
          semantic.state === "unavailable"
            ? "unavailable"
            : scopeMatchedNothing || semantic.state === "partial" || semanticSkippedFiles.length > 0
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
            filesAnalyzed: pythonSemanticAnalyzed,
            skippedFiles: pythonSemanticSkipped.sort(comparePortable),
          },
          pythonSemanticUnavailable > 0
            ? "unavailable"
            : scopeMatchedNothing || pythonSemanticPartial > 0 || pythonSemanticSkipped.length > 0
              ? "partial"
              : "complete",
          scopeMatchedNothing ? "The explicit --only filter matched no supported Python source paths." : undefined,
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
    schemaVersion: "footgun.scan-report.v2",
    tool: toolIdentity,
    repository,
    inventory,
    sourceDigest,
    configDigest: options.configDigest,
    findings: allFindings,
    coverage: resolvedCoverage.records,
    ...(semanticIndex === undefined ? {} : {context: semanticIndex}),
    diagnostics: [...diagnostics, ...resolvedCoverage.diagnostics],
    timings: {startedAt, durationMs: Math.max(0, performance.now() - started)},
    assumptions: [
      "Structural findings are candidates; type, caller, workload, and runtime evidence were not inferred.",
    ],
    nextAction:
      allFindings.length === 0
        ? "Review coverage and unknowns before concluding that no optimization candidate exists."
        : "Inspect the highest-ranked finding, resolve repository context, and declare behavior checks before measuring.",
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
  root: string,
  configDigest: string,
  revision: string | null,
  sourceDigest: string,
  files: ReadonlyArray<string>,
  selection: ScannerSelection,
  authorization: AdapterExecutionAuthorization,
  signal?: AbortSignal,
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
  const loaded = await resolveExternalAdapters(parsed, root, {
    authorization,
    ...(signal === undefined ? {} : {signal}),
  });
  const findings: FindingV2[] = [];
  const coverage: CoverageRecordV1[] = [];
  const diagnostics: ProblemV1[] = [...loaded.diagnostics];
  const rawArtifacts: string[] = [];
  const rawArtifactDigests: Record<string, string> = {};
  const sourceTargets = files.map((file) => portablePath(relative(root, file))).sort(comparePortable);
  const invalidCoverageIdentities = new Set<string>();
  for (const descriptor of loaded.descriptors) {
    if (descriptor.availability !== "invalid") continue;
    const scanner = `footgun.adapter:${descriptor.id}`;
    const identity = `${scanner}\0${descriptor.version}\0mixed`;
    if (invalidCoverageIdentities.has(identity)) continue;
    invalidCoverageIdentities.add(identity);
    coverage.push({
      scanner,
      version: descriptor.version,
      language: "mixed",
      filesDiscovered: files.length,
      filesAnalyzed: 0,
      parseStatus: "unavailable",
      skippedFiles: sourceTargets,
      reason: descriptor.reason ?? "Adapter manifest validation failed.",
    });
  }
  for (const adapter of loaded.adapters) {
    if (!runsAdapter(selection, adapter.manifest.id)) continue;
    const language = adapter.manifest.languages.length === 1 ? (adapter.manifest.languages[0] ?? "mixed") : "mixed";
    if (adapter.descriptor.availability !== "available") {
      diagnostics.push({
        schemaVersion: "footgun.problem.v1",
        code: "adapter-unavailable",
        message: `Adapter ${adapter.manifest.id} is unavailable.`,
        detail: adapter.descriptor.reason,
        recovery: "Install the declared adapter executable or remove it from the configured adapter list.",
      });
      coverage.push({
        scanner: `footgun.adapter:${adapter.manifest.id}`,
        version: adapter.manifest.version,
        language,
        filesDiscovered: files.length,
        filesAnalyzed: 0,
        parseStatus: "unavailable",
        skippedFiles: sourceTargets,
        reason: adapter.descriptor.reason ?? "Capability probe failed.",
      });
      continue;
    }
    const request: AdapterRequestV1 = {
      schemaVersion: "footgun.adapter-request.v1" as const,
      requestId: `req_${createHash("sha256")
        .update(`${adapter.manifest.id}\0${configDigest}\0${revision ?? ""}\0${sourceDigest}\0${files.join("\0")}`)
        .digest("hex")
        .slice(0, 16)}`,
      root,
      config: {scanner: adapter.manifest.id},
      operation: "scan" as const,
      targets: sourceTargets,
      revision,
      sourceDigest,
      configDigest,
      requestedCapabilities: adapter.manifest.capabilities,
      executionPolicy: {
        network: "disabled" as const,
        shell: false as const,
        maxOutputBytes: adapter.manifest.limits.maxOutputBytes,
      },
    };
    const result = await runParsedSubprocessAdapter(adapter.manifest, request, {
      root,
      ...(signal === undefined ? {} : {signal}),
    });
    if ("code" in result) {
      diagnostics.push(
        isWithinRoot(root, adapter.path) ? {...result, path: portablePath(relative(root, adapter.path))} : result,
      );
      coverage.push({
        scanner: `footgun.adapter:${adapter.manifest.id}`,
        version: adapter.manifest.version,
        language,
        filesDiscovered: files.length,
        filesAnalyzed: 0,
        parseStatus: "unavailable",
        skippedFiles: [...request.targets],
        reason: result.message,
      });
      continue;
    }
    findings.push(...result.findings);
    coverage.push(
      ...(result.coverage.length === 0
        ? [
            coverageRecord(
              {
                scanner: `footgun.adapter:${adapter.manifest.id}`,
                version: adapter.manifest.version,
                language,
                filesDiscovered: files.length,
                filesAnalyzed: result.state === "complete" ? files.length : 0,
                skippedFiles: result.state === "complete" ? [] : [...request.targets],
              },
              result.state === "complete" ? "complete" : result.state === "partial" ? "partial" : "unavailable",
              result.state === "complete" ? undefined : `Adapter state: ${result.state}`,
            ),
          ]
        : result.coverage),
    );
    diagnostics.push(...result.diagnostics);
    rawArtifacts.push(...result.rawArtifacts);
    Object.assign(rawArtifactDigests, result.rawArtifactDigests);
    if (result.state !== "complete" && result.state !== "partial")
      diagnostics.push({
        schemaVersion: "footgun.problem.v1",
        code: `adapter-${result.state}`,
        message: `Adapter ${adapter.manifest.id} returned ${result.state} coverage.`,
        recovery: "Inspect the adapter diagnostics and rerun with a compatible capability.",
      });
  }
  return {
    findings,
    coverage,
    diagnostics,
    rawArtifacts: [...new Set(rawArtifacts)].sort(comparePortable),
    rawArtifactDigests,
  };
}

async function collectFiles(
  root: string,
  excludes: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<{
  readonly files: ReadonlyArray<string>;
  readonly sourceSymlinks: ReadonlyArray<string>;
  readonly directorySymlinks: ReadonlyArray<string>;
}> {
  const files: string[] = [];
  const sourceSymlinks: string[] = [];
  const directorySymlinks: string[] = [];
  const rootInfo = await stat(root);
  if (rootInfo.isFile())
    return {files: isSupportedExtension(extensionOf(root)) ? [root] : [], sourceSymlinks, directorySymlinks};
  if (!rootInfo.isDirectory()) return {files, sourceSymlinks, directorySymlinks};
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => comparePortable(left.name, right.name));
    for (const entry of entries) {
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
        await visit(path);
      } else if (entry.isFile() && isSupportedExtension(extensionOf(path))) files.push(path);
    }
  };
  await visit(root);
  return {files, sourceSymlinks, directorySymlinks};
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

async function repositoryIdentity(
  root: string,
  analyzedFiles: ReadonlyArray<string>,
): Promise<ScanReportV2["repository"]> {
  const info = await stat(root);
  const repositoryRoot = info.isDirectory() ? root : resolve(root, "..");
  const revisionResult = await execa("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    reject: false,
    stdin: "ignore",
  });
  const dirtyResult = await execa("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repositoryRoot,
    reject: false,
    stdin: "ignore",
  });
  const ignoredAnalyzed = await execa(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      ...analyzedFiles.map((file) => relative(repositoryRoot, file)),
    ],
    {cwd: repositoryRoot, reject: false, stdin: "ignore"},
  );
  return {
    // Portable reports must not leak the host checkout path.
    root: ".",
    revision: revisionResult.exitCode === 0 ? revisionResult.stdout.trim() || null : null,
    dirty:
      (dirtyResult.exitCode === 0 && dirtyResult.stdout.trim().length > 0) ||
      (ignoredAnalyzed.exitCode === 0 && ignoredAnalyzed.stdout.trim().length > 0),
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

function relateFindings(findings: ReadonlyArray<FindingV2>): FindingV2[] {
  const result: FindingV2[] = [];
  const relatedFindingIds: Array<Set<string>> = [];
  const exact = new Set<string>();
  const nearby = new Map<string, number[]>();
  for (const finding of findings) {
    const exactKey = `${finding.location.path}\0${finding.location.startLine}\0${finding.ruleId}`;
    if (exact.has(exactKey)) continue;
    exact.add(exactKey);
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
      schemaVersion: "footgun.problem.v1",
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
        schemaVersion: "footgun.problem.v1",
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
