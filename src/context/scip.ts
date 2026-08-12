import {createHash} from "node:crypto";
import {isAbsolute, normalize, resolve, sep} from "node:path";
import {fromBinary} from "@bufbuild/protobuf";
import {IndexSchema, SymbolRole, type Occurrence, type SymbolInformation} from "@scip-code/scip";
import type {
  ContextCallV1,
  ContextDefinitionV1,
  ContextIndexV1,
  ContextReferenceV1,
  ProblemV1,
} from "../protocol/index.js";
import {comparePortable, portablePath} from "../paths.js";
import {readArtifactBytes} from "../artifacts/store.js";

export type ScipImportResult =
  | {
      readonly state: "complete" | "partial";
      readonly index: ContextIndexV1;
      readonly diagnostics: ReadonlyArray<ProblemV1>;
    }
  | {readonly state: "unavailable"; readonly diagnostics: ReadonlyArray<ProblemV1>};

/** Import a SCIP protobuf index as bounded, repository-relative local context. */
export async function importScip(path: string, root: string): Promise<ScipImportResult> {
  try {
    const repositoryRoot = resolve(root);
    const bytes = await readArtifactBytes(path);
    const parsed = fromBinary(IndexSchema, bytes);
    const diagnostics: ProblemV1[] = [];
    if (parsed.metadata === undefined)
      diagnostics.push(
        problem("scip-metadata-missing", "SCIP metadata is missing; tool and revision coverage cannot be established."),
      );

    // Build global symbol table for cross-document resolution (#119)
    const globalSymbols = buildGlobalSymbolTable(parsed.documents, parsed.externalSymbols);

    const definitions: ContextDefinitionV1[] = [];
    const references: ContextReferenceV1[] = [];
    const calls: ContextCallV1[] = [];
    const files: string[] = [];
    const indexedPaths = new Set<string>();
    for (const document of parsed.documents) {
      const documentPath = portableRelative(document.relativePath);
      if (documentPath === undefined) {
        diagnostics.push(
          problem(
            "scip-path-invalid",
            "A SCIP document path is not a canonical repository-relative path.",
            "Return canonical repository-relative paths from the indexer.",
          ),
        );
        continue;
      }
      const absoluteDocument = resolve(repositoryRoot, documentPath);
      if (absoluteDocument !== repositoryRoot && !absoluteDocument.startsWith(`${repositoryRoot}${sep}`)) {
        diagnostics.push(
          problem(
            "scip-path-outside-root",
            "A SCIP document path escapes the repository boundary.",
            "Return a repository-relative index or import it from the matching repository root.",
          ),
        );
        continue;
      }
      if (indexedPaths.has(documentPath)) {
        diagnostics.push(
          problem(
            "scip-document-duplicate",
            "A SCIP index contains the same repository-relative document more than once.",
            "Emit each repository-relative document once before importing the index.",
          ),
        );
        continue;
      }
      indexedPaths.add(documentPath);
      files.push(documentPath);
      const symbols = new Map(document.symbols.map((symbol) => [symbol.symbol, symbol]));
      for (const occurrence of document.occurrences) {
        if (occurrence.symbol.length === 0) continue;
        const range = occurrenceRange(occurrence);
        const localSymbol = symbols.get(occurrence.symbol);
        const globalSymbol = globalSymbols.get(occurrence.symbol);
        const symbol = localSymbol ?? globalSymbol;
        const name = symbol?.displayName || occurrence.symbol;
        if (range === undefined) {
          diagnostics.push(problem("scip-range-missing", `SCIP occurrence for ${name} has no usable range.`));
          continue;
        }
        const role = occurrence.symbolRoles;
        if ((role & SymbolRole.Definition) !== 0) {
          definitions.push({
            name,
            kind: String(symbol?.kind ?? "unknown"),
            path: documentPath,
            line: range.line,
            column: range.column,
            ...(symbol?.signatureDocumentation?.text === undefined ? {} : {type: symbol.signatureDocumentation.text}),
          });
        } else {
          references.push({
            name,
            path: documentPath,
            line: range.line,
            column: range.column,
            resolved: symbol !== undefined,
          });
        }
      }
    }
    const indexedFiles = [...new Set(files)].sort(comparePortable);
    const tool = parsed.metadata?.toolInfo;
    const index: ContextIndexV1 = {
      schemaVersion: "smokinggun.context-index.v1",
      tool: {name: tool?.name || "scip", version: tool?.version || "unknown"},
      files: indexedFiles,
      definitions: definitions.sort(compareDefinitions),
      references: references.sort(compareReferences),
      calls: calls.sort(compareCalls),
      coverage:
        diagnostics.length === 0
          ? {
              filesDiscovered: parsed.documents.length,
              filesIndexed: indexedFiles.length,
              parseStatus: "complete",
              skippedFiles: [],
            }
          : {
              filesDiscovered: parsed.documents.length,
              filesIndexed: indexedFiles.length,
              parseStatus: "partial",
              skippedFiles: [],
              reason: diagnostics.map((diagnostic) => diagnostic.message).join(" "),
            },
      revision: null,
      stale: true,
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
    return {state: diagnostics.length === 0 ? "complete" : "partial", index, diagnostics};
  } catch (cause: unknown) {
    return {
      state: "unavailable",
      diagnostics: [
        problem(
          "scip-import-failed",
          "The SCIP artifact could not be decoded.",
          cause instanceof Error ? cause.message : "Unknown protobuf decoding failure.",
        ),
      ],
    };
  }
}

function buildGlobalSymbolTable(
  documents: ReadonlyArray<{readonly symbols: ReadonlyArray<SymbolInformation>}>,
  externalSymbols: ReadonlyArray<SymbolInformation>,
): Map<string, SymbolInformation> {
  const table = new Map<string, SymbolInformation>();
  for (const document of documents) {
    for (const symbol of document.symbols) {
      if (!table.has(symbol.symbol)) {
        table.set(symbol.symbol, symbol);
      }
    }
  }
  for (const symbol of externalSymbols) {
    if (!table.has(symbol.symbol)) {
      table.set(symbol.symbol, symbol);
    }
  }
  return table;
}

function occurrenceRange(occurrence: Occurrence): {readonly line: number; readonly column: number} | undefined {
  if (occurrence.typedRange.case === "singleLineRange")
    return {line: occurrence.typedRange.value.line + 1, column: occurrence.typedRange.value.startCharacter};
  if (occurrence.typedRange.case === "multiLineRange")
    return {line: occurrence.typedRange.value.startLine + 1, column: occurrence.typedRange.value.startCharacter};
  if (occurrence.range.length >= 2) return {line: (occurrence.range[0] ?? 0) + 1, column: occurrence.range[1] ?? 0};
  return undefined;
}

function portableRelative(path: string): string | undefined {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\")) return undefined;
  const normalized = portablePath(normalize(path));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("//"))
    return undefined;
  return normalized;
}

function problem(code: string, message: string, detail?: string): ProblemV1 {
  return {
    schemaVersion: "smokinggun.problem.v1",
    code,
    message,
    ...(detail === undefined ? {} : {detail}),
    recovery: "Regenerate the index with a supported SCIP producer and rerun the import.",
  };
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
