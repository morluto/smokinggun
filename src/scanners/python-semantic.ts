import {inspectWithTreeSitter, type ParseCoverage} from "../parsers/tree-sitter-runtime.js";
import {makeFinding} from "./structural-finding.js";
import type {FindingV2, ProblemV1} from "../protocol/index.js";

export const pythonSemanticScannerId = "smokinggun.python-semantic";
export const pythonSemanticScannerVersion = "1.0.0";

export type PythonSemanticResult = {
  readonly findings: ReadonlyArray<FindingV2>;
  readonly coverage: ParseCoverage;
  readonly diagnostics: ReadonlyArray<ProblemV1>;
};

/** Infer only scanner-owned Python collection facts; no Python interpreter is required. */
export async function scanPythonSemantic(
  path: string,
  source: string,
  signal?: AbortSignal,
): Promise<PythonSemanticResult> {
  const result = await inspectWithTreeSitter(
    path,
    source,
    (root) => {
      const findings: FindingV2[] = [];
      const seen = new Set<string>();
      const visit = (node: import("web-tree-sitter").Node, loopDepth: number, environment: FlowEnvironment): void => {
        if (isAssignment(node.type)) {
          const right = node.childForFieldName("right") ?? node.childForFieldName("value");
          if (right !== null) visit(right, loopDepth, environment);
          const left = node.childForFieldName("left") ?? node.childForFieldName("target");
          if (left !== null) bindAssignment(left, inferCollectionKind(right), environment);
          return;
        }
        const isLoop = node.type === "for_statement" || node.type === "while_statement";
        const depth = loopDepth + (isLoop ? 1 : 0);
        if (loopDepth > 0 && node.type === "comparison_operator" && hasInOperator(node)) {
          const collection = membershipCollectionName(node);
          const kind = collection === undefined ? "unknown" : resolveCollectionKind(collection, environment);
          if (kind !== "indexed") {
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
                    : `Python semantic analysis inferred a ${kind} membership collection inside a loop.`,
                  "Confirm equality, mutation, and ordering semantics before replacing the collection with an indexed lookup.",
                  [
                    kind === "unknown" ? "collection type was unresolved" : `collection inferred as ${kind}`,
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
        const createsScope = isLexicalScope(node.type);
        const nestedEnvironment = createsScope ? {parent: environment, values: new Map()} : environment;
        for (const child of node.namedChildren) {
          if (isAssignment(node.type)) continue;
          const childEnvironment = isFlowBlock(node.type, child.type)
            ? cloneEnvironment(nestedEnvironment)
            : nestedEnvironment;
          visit(child, depth, childEnvironment);
        }
      };
      visit(root, 0, {values: new Map()});
      return findings;
    },
    signal,
  );
  return {
    findings: result._tag === "inspected" ? result.value : [],
    coverage: result.coverage,
    diagnostics:
      result.coverage.status === "complete"
        ? []
        : [
            {
              schemaVersion: "smokinggun.problem.v1",
              code: "python-semantic-coverage",
              message: `Python semantic coverage is ${result.coverage.status}.`,
              detail: result.coverage.error,
              recovery: "Inspect the Python file or rerun with a complete pinned grammar.",
            },
          ],
  };
}

type CollectionKind = "linear" | "indexed" | "unknown";

type FlowEnvironment = {
  readonly parent?: FlowEnvironment;
  readonly values: Map<string, CollectionKind>;
};

function isAssignment(type: string): boolean {
  return type === "assignment" || type === "annotated_assignment" || type === "augmented_assignment";
}

function isLexicalScope(type: string): boolean {
  return type === "function_definition" || type === "lambda" || type === "class_definition";
}

function isFlowBlock(parentType: string, childType: string): boolean {
  return (
    childType === "block" &&
    ["if_statement", "for_statement", "while_statement", "try_statement", "with_statement", "match_statement"].includes(
      parentType,
    )
  );
}

function cloneEnvironment(environment: FlowEnvironment): FlowEnvironment {
  return {
    ...(environment.parent === undefined ? {} : {parent: environment.parent}),
    values: new Map(environment.values),
  };
}

function bindAssignment(
  target: import("web-tree-sitter").Node,
  kind: CollectionKind,
  environment: FlowEnvironment,
): void {
  if (target.type === "identifier") {
    environment.values.set(target.text, kind);
    return;
  }
  for (const child of target.namedChildren) bindAssignment(child, "unknown", environment);
}

function inferCollectionKind(node: import("web-tree-sitter").Node | null): CollectionKind {
  if (node === null) return "unknown";
  if (["list", "list_comprehension", "tuple"].includes(node.type)) return "linear";
  if (["set", "set_comprehension", "dictionary", "dictionary_comprehension"].includes(node.type)) return "indexed";
  if (node.type !== "call") return "unknown";
  const callee = node.childForFieldName("function") ?? node.namedChildren[0];
  if (callee?.type !== "identifier") return "unknown";
  if (["set", "frozenset", "dict"].includes(callee.text)) return "indexed";
  if (["list", "tuple"].includes(callee.text)) return "linear";
  return "unknown";
}

function resolveCollectionKind(name: string, environment: FlowEnvironment): CollectionKind {
  for (let current: FlowEnvironment | undefined = environment; current !== undefined; current = current.parent) {
    const kind = current.values.get(name);
    if (kind !== undefined) return kind;
  }
  return "unknown";
}

function hasInOperator(node: import("web-tree-sitter").Node): boolean {
  return node.children.some((child) => child.type === "in" || child.text === "in");
}

function membershipCollectionName(node: import("web-tree-sitter").Node): string | undefined {
  const inIndex = node.children.findIndex((child) => child.type === "in" || child.text === "in");
  if (inIndex < 0) return undefined;
  const collection = node.children.slice(inIndex + 1).find((child) => child.isNamed);
  return collection?.type === "identifier" ? collection.text : undefined;
}
