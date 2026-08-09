import {createHash} from "node:crypto";
import {relative, resolve} from "node:path";
import * as ts from "typescript";
import type {
  ContextIndexV1,
  ContextCallV1,
  ContextDefinitionV1,
  ContextReferenceV1,
  ProblemV1,
} from "../protocol/index.js";
import {comparePortable, isWithinRoot, portablePath} from "../paths.js";
import {stableJson} from "../serialization.js";

export type TypeScriptIndexResult =
  | {
      readonly state: "complete" | "partial";
      readonly index: ContextIndexV1;
      readonly diagnostics: ReadonlyArray<ProblemV1>;
    }
  | {readonly state: "unavailable"; readonly diagnostics: ReadonlyArray<ProblemV1>};

export type TypeScriptAnalysis =
  | {readonly _tag: "NoSupportedTypeScriptSources"}
  | {
      readonly _tag: "PreparedTypeScriptAnalysis";
      readonly program: ts.Program;
      readonly sourcePaths: ReadonlyArray<string>;
      readonly selectedPaths: ReadonlySet<string>;
    };

const supportedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const maxContextEntriesPerKind = 10_000;

/** Prepare one compiler program and its exact selected source set for TypeScript analysis. */
export function prepareTypeScriptAnalysis(files: ReadonlyArray<string>): TypeScriptAnalysis {
  const sourcePaths = files.filter((path) => supportedExtensions.has(extensionOf(path))).map((path) => resolve(path));
  if (sourcePaths.length === 0) return {_tag: "NoSupportedTypeScriptSources"};
  return {
    _tag: "PreparedTypeScriptAnalysis",
    sourcePaths,
    selectedPaths: new Set(sourcePaths.map(canonicalPath)),
    program: ts.createProgram(sourcePaths, {
      allowJs: true,
      allowSyntheticDefaultImports: true,
      checkJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    }),
  };
}

/** Build a local, read-only TypeScript symbol/reference/call index without executing repository code. */
export function buildTypeScriptIndex(
  root: string,
  files: ReadonlyArray<string>,
  signal?: AbortSignal,
): TypeScriptIndexResult {
  return buildPreparedTypeScriptIndex(root, prepareTypeScriptAnalysis(files), signal);
}

/** Index the exact source set and compiler program produced by prepareTypeScriptAnalysis. */
export function buildPreparedTypeScriptIndex(
  root: string,
  analysis: TypeScriptAnalysis,
  signal?: AbortSignal,
): TypeScriptIndexResult {
  if (analysis._tag === "NoSupportedTypeScriptSources") return {state: "unavailable", diagnostics: []};
  const {program: compilerProgram, selectedPaths, sourcePaths} = analysis;
  const absoluteRoot = resolve(root);
  try {
    const checker = compilerProgram.getTypeChecker();
    const definitions: ContextDefinitionV1[] = [];
    const references: ContextReferenceV1[] = [];
    const calls: ContextCallV1[] = [];
    const declarationNames = new Set<ts.Node>();
    const diagnostics: ProblemV1[] = [];
    let contextTruncated = false;

    for (const sourceFile of compilerProgram.getSourceFiles()) {
      signal?.throwIfAborted();
      if (
        sourceFile.isDeclarationFile ||
        !isWithinRoot(absoluteRoot, resolve(sourceFile.fileName)) ||
        !selectedPaths.has(canonicalPath(resolve(sourceFile.fileName)))
      )
        continue;
      const relativePath = portablePath(relative(absoluteRoot, sourceFile.fileName));
      const visit = (node: ts.Node): void => {
        signal?.throwIfAborted();
        if (ts.isIdentifier(node)) {
          const symbol = checker.getSymbolAtLocation(node);
          if (symbol !== undefined) {
            const declaration = isDeclarationName(node);
            if (declaration) declarationNames.add(node);
            const location = locationOf(sourceFile, node);
            if (declaration) {
              if (definitions.length < maxContextEntriesPerKind)
                definitions.push({
                  name: symbol.getName(),
                  kind: ts.SyntaxKind[node.parent.kind] ?? "unknown",
                  path: relativePath,
                  line: location.line,
                  column: location.column,
                  type: typeText(checker, node),
                  alias: aliasName(checker, symbol),
                });
              else contextTruncated = true;
            } else {
              if (references.length < maxContextEntriesPerKind) {
                const declarations = symbol.getDeclarations();
                references.push({
                  name: symbol.getName(),
                  path: relativePath,
                  line: location.line,
                  column: location.column,
                  resolved: declarations !== undefined && declarations.length > 0,
                  alias: aliasName(checker, symbol),
                });
              } else contextTruncated = true;
            }
          }
        }
        if (ts.isCallExpression(node)) {
          const location = locationOf(sourceFile, node);
          if (calls.length < maxContextEntriesPerKind)
            calls.push({
              callee: node.expression.getText(sourceFile),
              path: relativePath,
              line: location.line,
              column: location.column,
            });
          else contextTruncated = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      const syntactic = compilerProgram.getSyntacticDiagnostics(sourceFile);
      diagnostics.push(...syntactic.map((diagnostic) => diagnosticToProblem(absoluteRoot, sourceFile, diagnostic)));
    }

    if (contextTruncated)
      diagnostics.push({
        schemaVersion: "footgun.problem.v1",
        code: "typescript-context-truncated",
        message: "The TypeScript context index reached its per-kind evidence limit.",
        recovery: "Use a narrower --only scope before relying on complete symbol, reference, or call context.",
      });
    const indexedFiles = sourcePaths
      .filter((path) => isWithinRoot(absoluteRoot, path))
      .map((path) => portablePath(relative(absoluteRoot, path)))
      .sort(comparePortable);
    const index: ContextIndexV1 = {
      schemaVersion: "footgun.context-index.v1",
      tool: {name: "typescript", version: ts.version},
      files: indexedFiles,
      definitions: definitions.sort(compareDefinitions),
      references: references.sort(compareReferences),
      calls: calls.sort(compareCalls),
      coverage:
        diagnostics.length === 0
          ? {
              filesDiscovered: sourcePaths.length,
              filesIndexed: indexedFiles.length,
              parseStatus: "complete",
              skippedFiles: [],
            }
          : {
              filesDiscovered: sourcePaths.length,
              filesIndexed: indexedFiles.length,
              parseStatus: "partial",
              skippedFiles: [],
              reason: diagnostics.map((diagnostic) => diagnostic.message).join(" "),
            },
      revision: null,
      stale: false,
      digest: createHash("sha256").update(stableJson({definitions, references, calls})).digest("hex"),
    };
    return {state: diagnostics.length === 0 ? "complete" : "partial", index, diagnostics};
  } catch (cause: unknown) {
    return {
      state: "unavailable",
      diagnostics: [
        {
          schemaVersion: "footgun.problem.v1",
          code: "typescript-index-failed",
          message: "TypeScript semantic indexing was unavailable.",
          detail: cause instanceof Error ? cause.message : "Unknown TypeScript compiler failure.",
          recovery: "Run the scan again after checking the TypeScript files and installed compiler.",
        },
      ],
    };
  }
}

/** Check whether a compiler source path belongs to the prepared analysis selection. */
export function isSelectedTypeScriptSource(analysis: TypeScriptAnalysis, path: string): boolean {
  return analysis._tag === "PreparedTypeScriptAnalysis" && analysis.selectedPaths.has(canonicalPath(resolve(path)));
}

function canonicalPath(path: string): string {
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return parent.name === node || parent.propertyName === node;
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  )
    return parent.name === node;
  return (
    (ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
    parent.name === node
  );
}

function typeText(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  try {
    const text = checker.typeToString(checker.getTypeAtLocation(node));
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function aliasName(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return undefined;
  try {
    const alias = checker.getAliasedSymbol(symbol);
    return alias === symbol ? undefined : alias.getName();
  } catch {
    return undefined;
  }
}

function locationOf(sourceFile: ts.SourceFile, node: ts.Node): {readonly line: number; readonly column: number} {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {line: position.line + 1, column: position.character};
}

function diagnosticToProblem(root: string, sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): ProblemV1 {
  const location =
    diagnostic.start === undefined ? undefined : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    schemaVersion: "footgun.problem.v1",
    code: "typescript-parse-error",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    path: portablePath(relative(root, sourceFile.fileName)),
    ...(location === undefined ? {} : {detail: `line ${location.line + 1}, column ${location.character + 1}`}),
    recovery: "Fix the syntax error or inspect the file manually; semantic coverage is partial.",
  };
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

function compareDefinitions(left: ContextDefinitionV1, right: ContextDefinitionV1): number {
  return (
    comparePortable(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    comparePortable(left.name, right.name)
  );
}

function compareReferences(left: ContextReferenceV1, right: ContextReferenceV1): number {
  return (
    comparePortable(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    comparePortable(left.name, right.name)
  );
}

function compareCalls(left: ContextCallV1, right: ContextCallV1): number {
  return (
    comparePortable(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    comparePortable(left.callee, right.callee)
  );
}
