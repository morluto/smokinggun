import {createHash} from "node:crypto";
import {relative, resolve} from "node:path";
import * as ts from "typescript";
import type {FindingV1, LocationV1, ProblemV1} from "../protocol/index.js";
import {buildTypeScriptIndex, type TypeScriptIndexResult} from "../context/index.js";
import {isWithinRoot, portablePath} from "../paths.js";

export const semanticScannerId = "footgun.typescript-semantic";
export const semanticScannerVersion = "1.0.0";

export type TypeScriptSemanticResult = TypeScriptIndexResult & {
  readonly findings: ReadonlyArray<FindingV1>;
};

/** Use the TypeScript compiler API for symbol-aware collection and call facts. */
export function scanTypeScript(
  root: string,
  files: ReadonlyArray<string>,
  signal?: AbortSignal,
): TypeScriptSemanticResult {
  const indexResult = buildTypeScriptIndex(root, files, signal);
  const sourcePaths = files.filter((path) => isTypeScriptPath(path)).map((path) => resolve(path));
  if (sourcePaths.length === 0 || indexResult.state === "unavailable") return {...indexResult, findings: []};
  const findings: FindingV1[] = [];
  try {
    const program = ts.createProgram(sourcePaths, {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    });
    const checker = program.getTypeChecker();
    const absoluteRoot = resolve(root);
    for (const sourceFile of program.getSourceFiles()) {
      signal?.throwIfAborted();
      if (sourceFile.isDeclarationFile || !isWithinRoot(absoluteRoot, resolve(sourceFile.fileName))) continue;
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
          if (name !== undefined && queryNames.has(name)) {
            findings.push(
              makeFinding(
                relativePath,
                sourceFile,
                node,
                "type-informed",
                `Potential ${name} call occurs inside a TypeScript loop.`,
                "Check for N+1 I/O or query behavior and batch only when authorization, ordering, errors, and caching remain equivalent.",
                [`call resolved as ${name}`, `enclosing loop depth: ${loopDepth}`],
                "typescript-call-in-loop",
              ),
            );
          }
        }
        ts.forEachChild(node, (child) => visit(child, nextDepth));
      };
      visit(sourceFile, 0);
    }
    return {...indexResult, findings: dedupe(findings)};
  } catch (cause: unknown) {
    const diagnostic: ProblemV1 = {
      schemaVersion: "footgun.problem.v1",
      code: "typescript-semantic-failed",
      message: "TypeScript semantic scanning was unavailable.",
      detail: cause instanceof Error ? cause.message : "Unknown TypeScript compiler failure.",
      recovery: "Inspect the TypeScript project configuration and rerun the scan.",
    };
    return {
      state: "partial",
      diagnostics: [...indexResult.diagnostics, diagnostic],
      findings: dedupe(findings),
      ...(indexResult.index === undefined ? {} : {index: indexResult.index}),
    };
  }
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
const queryNames = new Set(["fetch", "query", "execute", "findMany", "findOne", "findUnique"]);
const collectionTypePattern = /(?:\[\]|Array<|ReadonlyArray<|Set<|Map<|string)/;

function makeFinding(
  path: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  confidence: FindingV1["confidence"],
  message: string,
  suggestion: string,
  assumptions: ReadonlyArray<string>,
  ruleId: string,
): FindingV1 {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const line = start.line + 1;
  const id = `fg_${createHash("sha256")
    .update(`${path}\0${line}\0${ruleId}\0${node.getText(sourceFile)}`)
    .digest("hex")
    .slice(0, 16)}`;
  const location: LocationV1 = {
    path,
    startLine: line,
    startColumn: start.character,
    endLine: line,
    endColumn: start.character + Math.max(1, node.getWidth(sourceFile)),
  };
  return {
    schemaVersion: "footgun.finding.v1",
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

function isTypeScriptPath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}

function dedupe(findings: ReadonlyArray<FindingV1>): ReadonlyArray<FindingV1> {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.id)) return false;
    seen.add(finding.id);
    return true;
  });
}
