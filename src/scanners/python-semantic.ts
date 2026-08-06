import {inspectWithTreeSitter, type ParseCoverage} from "../parsers/tree-sitter-runtime.js";
import {makeFinding} from "./structural.js";
import type {FindingV1, ProblemV1} from "../protocol/index.js";

export const pythonSemanticScannerId = "footgun.python-semantic";
export const pythonSemanticScannerVersion = "1.0.0";

export type PythonSemanticResult = {
  readonly findings: ReadonlyArray<FindingV1>;
  readonly coverage: ParseCoverage;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
};

/** Infer only scanner-owned Python collection facts; no Python interpreter is required. */
export async function scanPythonSemantic(
  path: string,
  source: string,
  signal?: AbortSignal,
): Promise<PythonSemanticResult> {
  const collectionKinds = collectCollectionKinds(source);
  const result = await inspectWithTreeSitter(
    path,
    source,
    (root) => {
      const findings: FindingV1[] = [];
      const seen = new Set<string>();
      const visit = (node: import("web-tree-sitter").Node, loopDepth: number): void => {
        const isLoop = node.type === "for_statement" || node.type === "while_statement";
        const depth = loopDepth + (isLoop ? 1 : 0);
        if (loopDepth > 0 && node.type === "comparison_operator" && /\bin\b/.test(node.text)) {
          const match = node.text.match(/\bin\s+([A-Za-z_]\w*)/);
          const collection = match?.[1];
          const kind = collection === undefined ? "unknown" : (collectionKinds.get(collection) ?? "unknown");
          if (kind !== "set") {
            const line = node.startPosition.row + 1;
            const idKey = `${path}\0${line}\0${collection ?? "unknown"}`;
            if (!seen.has(idKey)) {
              seen.add(idKey);
              findings.push({
                ...makeFinding(
                  path,
                  line,
                  "python-collection-membership-in-loop",
                  "medium",
                  kind === "unknown"
                    ? "Python semantic analysis found membership inside a loop, but the collection type is unresolved."
                    : `Python semantic analysis inferred a ${kind}-like membership collection inside a loop.`,
                  "Confirm equality, mutation, and ordering semantics before replacing the collection with an indexed lookup.",
                  [
                    kind === "unknown" ? "collection type was unresolved" : `collection inferred as ${kind}-like`,
                    "the loop and collection sizes were not measured",
                  ],
                ),
                scanner: pythonSemanticScannerId,
                scannerVersion: pythonSemanticScannerVersion,
                confidence: kind === "unknown" ? "candidate" : "type-informed",
                claimClass: "theoretical-estimate",
              });
            }
          }
        }
        for (const child of node.namedChildren) visit(child, depth);
      };
      visit(root, 0);
      return findings;
    },
    signal,
  );
  return {
    findings: result.value ?? [],
    coverage: result.coverage,
    diagnostics:
      result.coverage.status === "complete"
        ? []
        : [
            {
              schemaVersion: "footgun.problem.v1",
              code: "python-semantic-coverage",
              message: `Python semantic coverage is ${result.coverage.status}.`,
              detail: result.coverage.error,
              recovery: "Inspect the Python file or rerun with a complete pinned grammar.",
            },
          ],
  };
}

function collectCollectionKinds(source: string): ReadonlyMap<string, "list" | "tuple" | "set"> {
  const result = new Map<string, "list" | "tuple" | "set">();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(
      /^\s*([A-Za-z_]\w*)\s*(?::\s*(?:list|tuple|set)\b)?\s*=\s*(\[|\(|\{|list\s*\(|tuple\s*\(|set\s*\(|frozenset\s*\()/i,
    );
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const token = match[2].toLowerCase();
    result.set(
      match[1],
      token === "{" || token.startsWith("set") || token.startsWith("frozenset")
        ? "set"
        : token.startsWith("(") || token.startsWith("tuple")
          ? "tuple"
          : "list",
    );
  }
  return result;
}
