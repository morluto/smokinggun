import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Worker} from "node:worker_threads";
import * as ts from "typescript";
import {z} from "zod";
import {Protocol, type FindingV2, type LocationV1, type ProblemV1} from "../protocol/index.js";
import {
  buildPreparedTypeScriptIndex,
  isSelectedTypeScriptSource,
  prepareTypeScriptAnalysis,
  prepareSnapshotTypeScriptAnalysis,
  type TypeScriptSourceInput,
  type TypeScriptIndexResult,
} from "../context/index.js";
import {isWithinRoot, portablePath} from "../paths.js";

export const semanticScannerId = "smokinggun.typescript-semantic";
export const semanticScannerVersion = "1.0.0";
const semanticWorkerOldGenerationLimitMb = 768;

export type TypeScriptSemanticResult = TypeScriptIndexResult & {
  readonly findings: ReadonlyArray<FindingV2>;
};

const workerResultSchema = z.strictObject({
  result: z.union([
    z.strictObject({
      state: z.enum(["complete", "partial"]),
      index: Protocol.contextIndex,
      diagnostics: z.array(Protocol.problem),
      findings: z.array(Protocol.finding),
    }),
    z.strictObject({
      state: z.literal("unavailable"),
      diagnostics: z.array(Protocol.problem),
      findings: z.array(Protocol.finding),
    }),
  ]),
});

/** Run TypeScript analysis in an isolated worker so process signals can stop CPU-bound compiler work. */
export async function scanTypeScript(
  root: string,
  files: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<TypeScriptSemanticResult> {
  signal?.throwIfAborted();
  const workerUrl = new URL("./typescript-semantic-worker.js", import.meta.url);
  if (!existsSync(fileURLToPath(workerUrl))) return scanTypeScriptSynchronously(root, files, signal);
  try {
    return await runTypeScriptWorker(workerUrl, root, files, signal);
  } catch (cause: unknown) {
    if (signal?.aborted) throw cause;
    return {state: "unavailable", diagnostics: [workerFailureProblem(cause)], findings: []};
  }
}

/** Analyze only source text retained by the host-owned immutable snapshot. */
export async function scanTypeScriptSnapshot(
  root: string,
  sources: ReadonlyArray<TypeScriptSourceInput>,
  signal?: AbortSignal,
): Promise<TypeScriptSemanticResult> {
  signal?.throwIfAborted();
  const workerUrl = new URL("./typescript-semantic-worker.js", import.meta.url);
  if (!existsSync(fileURLToPath(workerUrl)))
    return markSnapshotProjectContextPartial(scanTypeScriptSnapshotSynchronously(root, sources, signal));
  try {
    return markSnapshotProjectContextPartial(await runTypeScriptWorker(workerUrl, root, [], signal, sources));
  } catch (cause: unknown) {
    if (signal?.aborted) throw cause;
    return {state: "unavailable", diagnostics: [workerFailureProblem(cause)], findings: []};
  }
}

function markSnapshotProjectContextPartial(result: TypeScriptSemanticResult): TypeScriptSemanticResult {
  if (result.state === "unavailable") return result;
  const diagnostic: ProblemV1 = {
    schemaVersion: "smokinggun.problem.v1",
    code: "typescript-project-context-partial",
    message:
      "TypeScript sources were analyzed from immutable bytes without a captured project configuration or library set.",
    recovery:
      "Treat type resolution as partial until tsconfig, project references, and compiler libraries enter the snapshot.",
  };
  return {
    ...result,
    state: "partial",
    diagnostics: [...result.diagnostics, diagnostic],
    index: {
      ...result.index,
      coverage: {
        ...result.index.coverage,
        parseStatus: "partial",
        reason: diagnostic.message,
      },
    },
  };
}

/** Synchronous snapshot entrypoint used inside the bounded semantic worker. */
export function scanTypeScriptSnapshotSynchronously(
  root: string,
  sources: ReadonlyArray<TypeScriptSourceInput>,
  signal?: AbortSignal,
): TypeScriptSemanticResult {
  return scanPreparedTypeScript(root, prepareSnapshotTypeScriptAnalysis(root, sources), signal);
}

/** Analyze one selected TypeScript source set with one shared compiler Program and TypeChecker. */
export function scanTypeScriptSynchronously(
  root: string,
  files: ReadonlyArray<string>,
  signal?: AbortSignal,
): TypeScriptSemanticResult {
  return scanPreparedTypeScript(root, prepareTypeScriptAnalysis(files), signal);
}

function scanPreparedTypeScript(
  root: string,
  analysis: ReturnType<typeof prepareTypeScriptAnalysis>,
  signal?: AbortSignal,
): TypeScriptSemanticResult {
  if (analysis._tag === "NoSupportedTypeScriptSources")
    return {...buildPreparedTypeScriptIndex(root, analysis, signal), findings: []};
  const {program} = analysis;
  const findings: FindingV2[] = [];
  let context: Exclude<TypeScriptIndexResult, {readonly state: "unavailable"}> | undefined;
  try {
    const index = buildPreparedTypeScriptIndex(root, analysis, signal);
    if (index.state === "unavailable") return {...index, findings: []};
    context = index;
    const checker = program.getTypeChecker();
    const absoluteRoot = resolve(root);
    for (const sourceFile of program.getSourceFiles()) {
      signal?.throwIfAborted();
      const sourcePath = resolve(sourceFile.fileName);
      if (
        sourceFile.isDeclarationFile ||
        !isWithinRoot(absoluteRoot, sourcePath) ||
        !isSelectedTypeScriptSource(analysis, sourcePath)
      )
        continue;
      const relativePath = portablePath(relative(absoluteRoot, sourceFile.fileName));
      const visit = (node: ts.Node, loopDepth: number): void => {
        signal?.throwIfAborted();
        const nextDepth = loopDepth + (isLoop(node) ? 1 : 0);
        if (loopDepth > 0 && ts.isCallExpression(node)) {
          const name = callName(node);
          if (name !== undefined && collectionOperationNames.has(name)) {
            const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : undefined;
            const receiverType =
              receiver === undefined ? undefined : checker.typeToString(checker.getTypeAtLocation(receiver));
            const typed = receiverType !== undefined && collectionTypePattern.test(receiverType);
            findings.push(
              makeFinding(
                relativePath,
                sourceFile,
                node,
                typed ? "type-informed" : "candidate",
                typed
                  ? `TypeScript checker resolved ${receiverType} before a ${name} call inside a loop.`
                  : `Collection operation ${name} appears inside a loop; the receiver type is unresolved.`,
                typed
                  ? "Precompute an index or combine the collection pass while preserving ordering and mutation semantics."
                  : "Inspect the receiver type and consider a precomputed lookup or one-pass transformation.",
                [
                  typed ? `receiver type: ${receiverType}` : "receiver type was unknown",
                  `enclosing loop depth: ${loopDepth}`,
                ],
                "typescript-collection-operation-in-loop",
              ),
            );
          }
        }
        ts.forEachChild(node, (child) => visit(child, nextDepth));
      };
      visit(sourceFile, 0);
    }
    return {...context, findings: dedupe(findings)};
  } catch (cause: unknown) {
    const diagnostic: ProblemV1 = {
      schemaVersion: "smokinggun.problem.v1",
      code: "typescript-semantic-failed",
      message: "TypeScript semantic scanning was unavailable.",
      detail: cause instanceof Error ? cause.message : "Unknown TypeScript compiler failure.",
      recovery: "Inspect the TypeScript project configuration and rerun the scan.",
    };
    if (context === undefined) return {state: "unavailable", diagnostics: [diagnostic], findings: dedupe(findings)};
    return {
      state: "partial",
      diagnostics: [...context.diagnostics, diagnostic],
      findings: dedupe(findings),
      index: context.index,
    };
  }
}

function runTypeScriptWorker(
  workerUrl: URL,
  root: string,
  files: ReadonlyArray<string>,
  signal?: AbortSignal,
  sources?: ReadonlyArray<TypeScriptSourceInput>,
): Promise<TypeScriptSemanticResult> {
  return new Promise((resolveResult, rejectResult) => {
    const worker = new Worker(workerUrl, {
      workerData: {root, files, ...(sources === undefined ? {} : {sources})},
      execArgv: withoutWorkerHeapOverrides(process.execArgv),
      resourceLimits: {maxOldGenerationSizeMb: semanticWorkerOldGenerationLimitMb},
    });
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => {
      void worker.terminate();
      settle(() => rejectResult(new Error("TypeScript semantic analysis was cancelled.")));
    };
    signal?.addEventListener("abort", onAbort, {once: true});
    worker.once("message", (message: unknown) => {
      const parsed = workerResultSchema.safeParse(message);
      if (!parsed.success) {
        settle(() => rejectResult(new Error("TypeScript semantic analysis returned an invalid worker result.")));
        return;
      }
      settle(() => resolveResult(parsed.data.result));
    });
    worker.once("error", (cause) => settle(() => rejectResult(cause)));
    worker.once("exit", (code) => {
      if (code !== 0) settle(() => rejectResult(new Error(`TypeScript semantic worker exited with code ${code}.`)));
    });
  });
}

function withoutWorkerHeapOverrides(arguments_: ReadonlyArray<string>): string[] {
  const result: string[] = [];
  let skipValue = false;
  for (const argument of arguments_) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (
      argument === "--max-old-space-size" ||
      argument === "--max-old-space-size-percentage" ||
      argument.startsWith("--max-old-space-size=") ||
      argument.startsWith("--max-old-space-size-percentage=")
    ) {
      skipValue = !argument.includes("=");
      continue;
    }
    result.push(argument);
  }
  return result;
}

function workerFailureProblem(cause: unknown): ProblemV1 {
  const detail = cause instanceof Error ? cause.message : "Unknown TypeScript semantic worker failure.";
  const reachedMemoryLimit = detail.includes("memory limit");
  return {
    schemaVersion: "smokinggun.problem.v1",
    code: reachedMemoryLimit ? "typescript-semantic-resource-limit" : "typescript-semantic-worker-failed",
    message: reachedMemoryLimit
      ? "TypeScript semantic analysis exceeded its worker memory limit."
      : "TypeScript semantic analysis worker failed.",
    detail,
    recovery: "Use a narrower --only scope or rerun with --scanner structural.",
  };
}

const collectionOperationNames = new Set([
  "find",
  "findIndex",
  "includes",
  "indexOf",
  "filter",
  "map",
  "reduce",
  "sort",
]);
const collectionTypePattern = /(?:\[\]|Array<|ReadonlyArray<|Set<|Map<|string)/;

function makeFinding(
  path: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  confidence: FindingV2["confidence"],
  message: string,
  suggestion: string,
  assumptions: ReadonlyArray<string>,
  ruleId: string,
): FindingV2 {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const line = start.line + 1;
  const id = `sg_${createHash("sha256")
    .update(`${path}\0${line}\0${ruleId}\0${node.getText(sourceFile)}`)
    .digest("hex")
    .slice(0, 16)}`;
  const location: LocationV1 = {
    path,
    startLine: line,
    startColumn: start.character,
    endLine: end.line + 1,
    endColumn: end.character,
  };
  return {
    schemaVersion: "smokinggun.finding.v2",
    id,
    scanner: semanticScannerId,
    scannerVersion: semanticScannerVersion,
    ruleId,
    language: "typescript",
    kind: ruleId,
    claimClass: "theoretical-estimate",
    severity: ruleId === "typescript-call-in-loop" ? "high" : "medium",
    confidence,
    status: "unvalidated",
    relatedFindings: [],
    message,
    suggestion,
    location,
    assumptions: [...assumptions],
    evidence: [`${semanticScannerId}:${ruleId}`],
    complexity: {current: "repeated work per enclosing loop", expected: "indexed, batched, or one-pass work"},
  };
}

function callName(node: ts.CallExpression): string | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  return undefined;
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function dedupe(findings: ReadonlyArray<FindingV2>): ReadonlyArray<FindingV2> {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.id)) return false;
    seen.add(finding.id);
    return true;
  });
}
