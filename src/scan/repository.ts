import {readFile, readdir, stat} from "node:fs/promises";
import {relative, resolve} from "node:path";
import {execa} from "execa";
import type {CoverageRecordV1, FindingV1, ProblemV1, ScanReportV1} from "../protocol/index.js";
import {parseWithTreeSitter} from "../parsers/tree-sitter-runtime.js";
import {scanWithTreeSitter} from "../scanners/tree-sitter-structural.js";
import {
  scanPythonSemantic,
  pythonSemanticScannerId,
  pythonSemanticScannerVersion,
} from "../scanners/python-semantic.js";
import {isSupportedExtension, scanSource, scannerId, scannerVersion} from "../scanners/structural.js";
import {scanTypeScript, semanticScannerId, semanticScannerVersion} from "../scanners/typescript-semantic.js";
import {comparePortable, portablePath} from "../paths.js";
import {buildRepositoryInventory} from "./inventory.js";
import {loadExternalAdapters} from "../scanners/external.js";
import {runSubprocessAdapter} from "../adapters/subprocess.js";
import {createHash} from "node:crypto";
import {toolIdentity} from "../tool-identity.js";

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
  readonly excludes?: ReadonlyArray<string>;
  readonly maxFindings?: number;
  readonly signal?: AbortSignal;
  readonly scanners?: ReadonlyArray<string>;
  readonly only?: ReadonlyArray<string>;
  readonly adapterManifests?: ReadonlyArray<string>;
  readonly allowAdapterExecution?: boolean;
};

/** Scan one local repository without executing source code or contacting the network. */
export async function scanRepository(inputRoot: string, options: ScanOptions): Promise<ScanReportV1> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const root = resolve(inputRoot);
  const rootInfo = await stat(root);
  const pathRoot = rootInfo.isDirectory() ? root : resolve(root, "..");
  const excludes = new Set([...defaultExcludes, ...(options.excludes ?? [])]);
  const discoveredFiles = await collectFiles(root, excludes, options.signal);
  const files = discoveredFiles.filter((file) => matchesOnlyFilter(file, options.only));
  const selectedScanners = normalizeScannerSelection(options.scanners);
  const runStructural =
    selectedScanners === undefined ||
    selectedScanners.has("auto") ||
    selectedScanners.has("structural") ||
    selectedScanners.has(scannerId) ||
    selectedScanners.has("tree-sitter");
  const runTypeScript =
    selectedScanners === undefined ||
    selectedScanners.has("auto") ||
    selectedScanners.has("typescript") ||
    selectedScanners.has("typescript-semantic") ||
    selectedScanners.has(semanticScannerId);
  const runPython =
    selectedScanners === undefined ||
    selectedScanners.has("auto") ||
    selectedScanners.has("python") ||
    selectedScanners.has("python-semantic");
  const findings: FindingV1[] = [];
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
  let pythonSemanticDiscovered = 0;
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
      skippedFiles.push(portablePath(relative(pathRoot, file)));
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
    const parserResult = treeStructural?.coverage ?? (await parseWithTreeSitter(reportPath, source, options.signal));
    const parserEntry = parserCoverage.get(parserResult.language) ?? {
      discovered: 0,
      analyzed: 0,
      partial: 0,
      unavailable: 0,
      skipped: [],
      reasons: new Set<string>(),
    };
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
    if (parserResult.error !== undefined) parserEntry.reasons.add(parserResult.error);
    if (parserResult.error !== undefined)
      parseDiagnostics.push({
        schemaVersion: "footgun.problem.v1",
        code: parserResult.status === "unavailable" ? "parser-unavailable" : "partial-parse",
        message: `Tree-sitter coverage is ${parserResult.status} for ${reportPath}.`,
        path: reportPath,
        detail: parserResult.error,
        recovery: "Inspect the file manually or verify the pinned grammar asset.",
      });
    parserCoverage.set(parserResult.language, parserEntry);
    if (runPython) {
      if (extensionOf(reportPath).toLowerCase() === ".py") {
        pythonSemanticDiscovered += 1;
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
    ? scanTypeScript(pathRoot, analyzedFiles, options.signal)
    : {
        state: "unavailable" as const,
        diagnostics: [
          {
            schemaVersion: "footgun.problem.v1" as const,
            code: "scanner-skipped",
            message: "TypeScript semantic scanning was not selected.",
            recovery: "Select the TypeScript scanner explicitly to enable semantic analysis.",
          },
        ],
        findings: [],
      };
  findings.push(...semantic.findings);
  parseDiagnostics.push(...semantic.diagnostics);
  const repository = await repositoryIdentity(root);
  const inventory = await buildRepositoryInventory(pathRoot, files, [...excludes]);
  const sourceDigest = sourceHasher.digest("hex");
  const adapterRun = await runConfiguredAdapters(
    options.adapterManifests ?? [],
    pathRoot,
    options.configDigest,
    repository.revision,
    sourceDigest,
    files,
    selectedScanners,
    options.signal,
    options.allowAdapterExecution ?? false,
  );
  findings.push(...adapterRun.findings);
  parseDiagnostics.push(...adapterRun.diagnostics);
  parseDiagnostics.push(...scannerDisagreements(findings));
  const allFindings = relateFindings(findings)
    .sort(compareFindings)
    .slice(0, options.maxFindings ?? 80);
  const coverage: CoverageRecordV1 = {
    scanner: scannerId,
    version: scannerVersion,
    language: "mixed",
    filesDiscovered: files.length,
    filesAnalyzed: runStructural ? analyzed : 0,
    parseStatus: !runStructural
      ? "unavailable"
      : files.length > 0 && analyzed === 0
        ? "unavailable"
        : partial
          ? "partial"
          : "complete",
    skippedFiles: (!runStructural ? files.map((file) => portablePath(relative(pathRoot, file))) : skippedFiles).sort(
      comparePortable,
    ),
    ...(partialReason === undefined
      ? !runStructural
        ? {reason: "Structural scanner was not selected."}
        : {}
      : {reason: partialReason}),
  };
  const diagnostics: ProblemV1[] = [
    ...parseDiagnostics,
    ...skippedFiles.map((path): ProblemV1 => ({
      schemaVersion: "footgun.problem.v1",
      code: "file-unavailable",
      message: `Skipped ${path} because it could not be read.`,
      path,
      recovery: "Check file permissions and rerun the scan.",
    })),
  ];
  const parserRecords = [...parserCoverage.entries()]
    .sort(([left], [right]) => comparePortable(left, right))
    .map(([language, entry]): CoverageRecordV1 => ({
      scanner: "footgun.tree-sitter",
      version: "0.26.11",
      language,
      filesDiscovered: entry.discovered,
      filesAnalyzed: entry.analyzed,
      parseStatus: entry.unavailable > 0 ? "unavailable" : entry.partial > 0 ? "partial" : "complete",
      skippedFiles: entry.skipped.sort(comparePortable),
      ...(entry.reasons.size === 0 ? {} : {reason: [...entry.reasons].sort(comparePortable).join(" ")}),
    }));
  const semanticCoverage: CoverageRecordV1 | undefined = analyzedFiles.some((file) => isTypeScriptPath(file))
    ? {
        scanner: semanticScannerId,
        version: semanticScannerVersion,
        language: "typescript-javascript",
        filesDiscovered: analyzedFiles.filter(isTypeScriptPath).length,
        filesAnalyzed: semantic.index?.coverage.filesIndexed ?? 0,
        parseStatus:
          semantic.state === "complete" ? "complete" : semantic.state === "partial" ? "partial" : "unavailable",
        skippedFiles: [...(semantic.index?.coverage.skippedFiles ?? [])],
        ...(semantic.diagnostics.length === 0
          ? {}
          : {reason: semantic.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}),
      }
    : undefined;
  const pythonCoverage: CoverageRecordV1 | undefined =
    pythonSemanticDiscovered === 0
      ? undefined
      : {
          scanner: pythonSemanticScannerId,
          version: pythonSemanticScannerVersion,
          language: "python",
          filesDiscovered: pythonSemanticDiscovered,
          filesAnalyzed: pythonSemanticAnalyzed,
          parseStatus:
            pythonSemanticUnavailable > 0 ? "unavailable" : pythonSemanticPartial > 0 ? "partial" : "complete",
          skippedFiles: pythonSemanticSkipped.sort(comparePortable),
        };
  return {
    schemaVersion: "footgun.scan-report.v1",
    tool: toolIdentity,
    repository,
    inventory,
    sourceDigest,
    configDigest: options.configDigest,
    findings: allFindings,
    coverage: [
      coverage,
      ...parserRecords,
      ...(semanticCoverage === undefined ? [] : [semanticCoverage]),
      ...(pythonCoverage === undefined ? [] : [pythonCoverage]),
      ...adapterRun.coverage,
    ],
    ...(semantic.index === undefined ? {} : {context: semantic.index}),
    diagnostics,
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
  };
}

async function runConfiguredAdapters(
  manifestPaths: ReadonlyArray<string>,
  root: string,
  configDigest: string,
  revision: string | null,
  sourceDigest: string,
  files: ReadonlyArray<string>,
  selected: ReadonlySet<string> | undefined,
  signal?: AbortSignal,
  allowAdapterExecution = false,
): Promise<{
  readonly findings: ReadonlyArray<FindingV1>;
  readonly coverage: ReadonlyArray<CoverageRecordV1>;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
  readonly rawArtifacts: ReadonlyArray<string>;
}> {
  const builtin = new Set([
    "auto",
    "structural",
    "tree-sitter",
    "typescript",
    "typescript-semantic",
    "python",
    "python-semantic",
    scannerId,
    semanticScannerId,
  ]);
  if (manifestPaths.length === 0)
    return {
      findings: [],
      coverage: [],
      diagnostics: [...(selected ?? [])]
        .filter((requested) => !builtin.has(requested))
        .map((requested): ProblemV1 => ({
          schemaVersion: "footgun.problem.v1",
          code: "scanner-unavailable",
          message: `Scanner ${requested} was explicitly requested but is not configured.`,
          recovery: "Configure an adapter manifest or select a built-in scanner ID.",
        })),
      rawArtifacts: [],
    };
  const loaded = await loadExternalAdapters(manifestPaths, root, signal, allowAdapterExecution);
  const findings: FindingV1[] = [];
  const coverage: CoverageRecordV1[] = [];
  const diagnostics: ProblemV1[] = [...loaded.diagnostics];
  const rawArtifacts: string[] = [];
  const configuredIds = new Set(loaded.adapters.map((adapter) => adapter.manifest.id));
  for (const descriptor of loaded.descriptors) {
    if (descriptor.availability !== "invalid") continue;
    coverage.push({
      scanner: `footgun.adapter:${descriptor.id}`,
      version: descriptor.version,
      language: "mixed",
      filesDiscovered: files.length,
      filesAnalyzed: 0,
      parseStatus: "unavailable",
      skippedFiles: files.map((file) => portablePath(relative(root, file))).sort(comparePortable),
      reason: descriptor.reason ?? "Adapter manifest validation failed.",
    });
  }
  for (const requested of selected ?? []) {
    if (builtin.has(requested)) continue;
    if (!configuredIds.has(requested))
      diagnostics.push({
        schemaVersion: "footgun.problem.v1",
        code: "scanner-unavailable",
        message: `Scanner ${requested} was explicitly requested but is not configured.`,
        recovery: "Configure an adapter manifest or select a built-in scanner ID.",
      });
  }
  for (const adapter of loaded.adapters) {
    if (selected !== undefined && !selected.has("auto") && !selected.has(adapter.manifest.id)) continue;
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
        skippedFiles: files.map((file) => portablePath(relative(root, file))).sort(comparePortable),
        reason: adapter.descriptor.reason ?? "Capability probe failed.",
      });
      continue;
    }
    const request = {
      schemaVersion: "footgun.adapter-request.v1" as const,
      requestId: `req_${createHash("sha256")
        .update(`${adapter.manifest.id}\0${configDigest}\0${revision ?? ""}\0${sourceDigest}\0${files.join("\0")}`)
        .digest("hex")
        .slice(0, 16)}`,
      root,
      config: {scanner: adapter.manifest.id},
      operation: "scan" as const,
      targets: files.map((file) => portablePath(relative(root, file))).sort(comparePortable),
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
    const result = await runSubprocessAdapter(adapter.manifest, request, {
      root,
      ...(signal === undefined ? {} : {signal}),
    });
    if ("code" in result) {
      diagnostics.push({...result, path: adapter.path});
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
            {
              scanner: `footgun.adapter:${adapter.manifest.id}`,
              version: adapter.manifest.version,
              language,
              filesDiscovered: files.length,
              filesAnalyzed: result.state === "complete" ? files.length : 0,
              parseStatus:
                result.state === "complete"
                  ? ("complete" as const)
                  : result.state === "partial"
                    ? ("partial" as const)
                    : ("unavailable" as const),
              skippedFiles: result.state === "complete" ? [] : [...request.targets],
              ...(result.state === "complete" ? {} : {reason: `Adapter state: ${result.state}`}),
            },
          ]
        : result.coverage),
    );
    diagnostics.push(...result.diagnostics);
    rawArtifacts.push(...result.rawArtifacts);
    if (result.state !== "complete" && result.state !== "partial")
      diagnostics.push({
        schemaVersion: "footgun.problem.v1",
        code: `adapter-${result.state}`,
        message: `Adapter ${adapter.manifest.id} returned ${result.state} coverage.`,
        recovery: "Inspect the adapter diagnostics and rerun with a compatible capability.",
      });
  }
  return {findings, coverage, diagnostics, rawArtifacts: [...new Set(rawArtifacts)].sort(comparePortable)};
}

async function collectFiles(
  root: string,
  excludes: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const rootInfo = await stat(root);
  if (rootInfo.isFile()) return isSupportedExtension(extensionOf(root)) ? [root] : [];
  if (!rootInfo.isDirectory()) return [];
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(directory, {withFileTypes: true});
    entries.sort((left, right) => comparePortable(left.name, right.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (excludes.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && isSupportedExtension(extensionOf(path))) files.push(path);
    }
  };
  await visit(root);
  return files;
}

function normalizeScannerSelection(values: ReadonlyArray<string> | undefined): ReadonlySet<string> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return new Set(
    values.flatMap((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function matchesOnlyFilter(path: string, filters: ReadonlyArray<string> | undefined): boolean {
  if (filters === undefined || filters.length === 0) return true;
  const portable = portablePath(path);
  const extension = extensionOf(path).toLowerCase();
  return filters.some((filter) => {
    const value = filter.startsWith("language:")
      ? filter.slice("language:".length).toLowerCase()
      : filter.toLowerCase();
    const language =
      extension === ".py"
        ? "python"
        : [".ts", ".tsx"].includes(extension)
          ? "typescript"
          : [".js", ".jsx", ".mjs", ".cjs"].includes(extension)
            ? "javascript"
            : extension.slice(1);
    return value === language || value === extension || portable.endsWith(filter) || portable.includes(filter);
  });
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

async function repositoryIdentity(root: string): Promise<ScanReportV1["repository"]> {
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
  return {
    // Portable reports must not leak the host checkout path.
    root: ".",
    revision: revisionResult.exitCode === 0 ? revisionResult.stdout.trim() || null : null,
    dirty: dirtyResult.exitCode === 0 && dirtyResult.stdout.trim().length > 0,
  };
}

function compareFindings(left: FindingV1, right: FindingV1): number {
  const severity = {high: 0, medium: 1, low: 2, info: 3};
  return (
    severity[left.severity] - severity[right.severity] ||
    comparePortable(left.location.path, right.location.path) ||
    left.location.startLine - right.location.startLine ||
    comparePortable(left.ruleId, right.ruleId) ||
    comparePortable(left.id, right.id)
  );
}

function relateFindings(findings: ReadonlyArray<FindingV1>): FindingV1[] {
  const result: FindingV1[] = [];
  const exact = new Set<string>();
  for (const finding of findings) {
    const exactKey = `${finding.location.path}\0${finding.location.startLine}\0${finding.ruleId}`;
    if (exact.has(exactKey)) continue;
    exact.add(exactKey);
    const family = findingFamily(finding.ruleId);
    const related = result
      .filter(
        (prior) =>
          findingFamily(prior.ruleId) === family &&
          prior.location.path === finding.location.path &&
          Math.abs(prior.location.startLine - finding.location.startLine) <= 1,
      )
      .map((prior) => prior.id);
    const relatedFindings = [...new Set([...finding.relatedFindings, ...related])].sort(comparePortable);
    const next = {...finding, relatedFindings};
    if (related.length > 0) {
      for (let index = 0; index < result.length; index += 1) {
        const prior = result[index];
        if (prior !== undefined && related.includes(prior.id))
          result[index] = {
            ...prior,
            relatedFindings: [...new Set([...prior.relatedFindings, finding.id])].sort(comparePortable),
          };
      }
    }
    result.push(next);
  }
  return result;
}

function findingFamily(ruleId: string): string {
  if (/membership|collection|repeated-scan|sort-in-loop|render-derived-work/.test(ruleId)) return "collection";
  if (/query|io-or/.test(ruleId)) return "io";
  if (/loop|recursive/.test(ruleId)) return "iteration";
  return ruleId;
}

function scannerDisagreements(findings: ReadonlyArray<FindingV1>): ReadonlyArray<ProblemV1> {
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
