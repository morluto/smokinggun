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

const supportedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Build a local, read-only TypeScript symbol/reference/call index without executing repository code. */
export function buildTypeScriptIndex(
  root: string,
  files: ReadonlyArray<string>,
  signal?: AbortSignal,
): TypeScriptIndexResult {
  const absoluteRoot = resolve(root);
  const canonical = (path: string): string => (ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase());
  const sourcePaths = files.filter((path) => supportedExtensions.has(extensionOf(path))).map((path) => resolve(path));
  const selectedPaths = new Set(sourcePaths.map(canonical));
  if (sourcePaths.length === 0) return {state: "unavailable", diagnostics: []};
  try {
    const program = ts.createProgram(sourcePaths, {
      allowJs: true,
      allowSyntheticDefaultImports: true,
      checkJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    });
    const checker = program.getTypeChecker();
    const definitions: ContextDefinitionV1[] = [];
    const references: ContextReferenceV1[] = [];
    const calls: ContextCallV1[] = [];
    const declarationNames = new Set<ts.Node>();
    const diagnostics: ProblemV1[] = [];

    for (const sourceFile of program.getSourceFiles()) {
      signal?.throwIfAborted();
      if (
        sourceFile.isDeclarationFile ||
        !isWithinRoot(absoluteRoot, resolve(sourceFile.fileName)) ||
        !selectedPaths.has(canonical(resolve(sourceFile.fileName)))
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
              definitions.push({
                name: symbol.getName(),
                kind: ts.SyntaxKind[node.parent.kind] ?? "unknown",
                path: relativePath,
                line: location.line,
                column: location.column,
                type: typeText(checker, node),
                alias: aliasName(checker, symbol),
              });
            } else {
              references.push({
                name: symbol.getName(),
                path: relativePath,
                line: location.line,
                column: location.column,
                resolved: symbol.getDeclarations()?.length !== 0,
                alias: aliasName(checker, symbol),
              });
            }
          }
        }
        if (ts.isCallExpression(node)) {
          const location = locationOf(sourceFile, node);
          calls.push({
            callee: node.expression.getText(sourceFile),
            path: relativePath,
            line: location.line,
            column: location.column,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      const syntactic = program.getSyntacticDiagnostics(sourceFile);
      diagnostics.push(...syntactic.map((diagnostic) => diagnosticToProblem(absoluteRoot, sourceFile, diagnostic)));
    }

    const index: ContextIndexV1 = {
      schemaVersion: "footgun.context-index.v1",
      tool: {name: "typescript", version: ts.version},
      files: sourcePaths
        .filter((path) => isWithinRoot(absoluteRoot, path))
        .map((path) => portablePath(relative(absoluteRoot, path)))
        .sort(comparePortable),
      definitions: definitions.sort(compareDefinitions),
      references: references.sort(compareReferences),
      calls: calls.sort(compareCalls),
      coverage: {
        filesDiscovered: sourcePaths.length,
        filesIndexed: sourcePaths.filter((path) => isWithinRoot(absoluteRoot, path)).length,
        parseStatus: diagnostics.length === 0 ? "complete" : "partial",
        skippedFiles: [],
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
