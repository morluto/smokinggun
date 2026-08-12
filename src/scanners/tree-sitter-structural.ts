import type {Node} from "web-tree-sitter";
import {inspectWithTreeSitter, type ParseCoverage} from "../parsers/tree-sitter-runtime.js";
import {makeFinding} from "./structural-finding.js";
import type {FindingV2} from "../protocol/index.js";

const loopTypes = new Set([
  "for_statement",
  "for_in_statement",
  "for_of_statement",
  "enhanced_for_statement",
  "foreach_statement",
  "for_range_loop",
  "while_statement",
  "do_statement",
  "for_expression",
  "for_in_expression",
  "do_block",
]);
const callTypes = new Set([
  "call",
  "call_expression",
  "method_invocation",
  "call_expression_statement",
  "invocation_expression",
  "function_call_expression",
]);

export type TreeStructuralResult = {
  readonly findings: ReadonlyArray<FindingV2>;
  readonly coverage: ParseCoverage;
};

/** Derive syntax findings from named Tree-sitter nodes, retaining the parser as the structural source of truth. */
export async function scanWithTreeSitter(
  path: string,
  source: string,
  signal?: AbortSignal,
): Promise<TreeStructuralResult> {
  const result = await inspectWithTreeSitter(path, source, (root) => collectFindings(root, path), signal);
  return {findings: result._tag === "inspected" ? result.value : [], coverage: result.coverage};
}

function collectFindings(root: Node, path: string): ReadonlyArray<FindingV2> {
  const findings: FindingV2[] = [];
  const seen = new Set<string>();
  const visit = (node: Node, loopDepth: number): void => {
    const nested = loopDepth > 0 && loopTypes.has(node.type);
    const currentDepth = loopDepth + (loopTypes.has(node.type) ? 1 : 0);
    if (nested)
      add(
        makeFinding(
          path,
          node.startPosition.row + 1,
          "nested-or-callback-loop",
          "medium",
          "Tree-sitter found an iterative region inside another iterative region.",
          "Check whether indexing, grouping, batching, or a single-pass algorithm can remove repeated scans.",
          ["input bounds, runtime frequency, and dependency between the iterations are unknown"],
        ),
      );
    if (loopDepth > 0) {
      if (callTypes.has(node.type)) {
        const callee = findCalleeName(node);
        if (callee !== undefined) {
          if (isSortMethod(callee)) {
            add(
              makeFinding(
                path,
                node.startPosition.row + 1,
                "sort-in-loop",
                "high",
                "Tree-sitter found sorting inside iterative code.",
                "Move sorting out of the loop or use a heap/binary-search strategy if intermediate order is needed.",
                ["sort cost depends on collection size"],
              ),
            );
          } else if (isTransformMethod(callee)) {
            add(
              makeFinding(
                path,
                node.startPosition.row + 1,
                "repeated-scan",
                "medium",
                "Tree-sitter found a collection transform inside iterative code.",
                "Consider precomputing an index/grouping or combining passes.",
                ["the transform may traverse a collection once per enclosing iteration"],
              ),
            );
          } else if (isMembershipMethod(callee)) {
            add(
              makeFinding(
                path,
                node.startPosition.row + 1,
                "membership-in-loop",
                "medium",
                "Tree-sitter found a membership or search operation inside iterative code.",
                "Consider a Set/Map or precomputed lookup if equality and ordering semantics allow it.",
                ["the right-hand collection type and size are unknown"],
              ),
            );
          }
        }
      } else if (
        node.type === "comparison_operator" ||
        node.type === "binary_expression" ||
        node.type === "binary_expression_inner"
      ) {
        if (hasMembershipOperator(node)) {
          add(
            makeFinding(
              path,
              node.startPosition.row + 1,
              "membership-in-loop",
              "medium",
              "Tree-sitter found a membership or search operation inside iterative code.",
              "Consider a Set/Map or precomputed lookup if equality and ordering semantics allow it.",
              ["the right-hand collection type and size are unknown"],
            ),
          );
        }
      }
    }
    for (const child of node.namedChildren) visit(child, currentDepth);
  };
  visit(root, 0);
  return findings;

  function add(finding: FindingV2): void {
    const key = `${finding.location.path}\0${finding.location.startLine}\0${finding.ruleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  }
}

/** Extract the callee identifier from a call-expression node. */
function findCalleeName(node: Node): string | undefined {
  const callee =
    node.childForFieldName("function") ??
    node.childForFieldName("name") ??
    node.childForFieldName("method") ??
    node.childForFieldName("callee") ??
    node.namedChildren.find((child) => !isArgumentContainer(child.type));
  if (callee === undefined) return undefined;
  const names: string[] = [];
  collectIdentifierNames(callee, names);
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    if (name !== undefined && isKnownCollectionMethod(name)) return name;
  }
  return names.at(-1);
}

function collectIdentifierNames(node: Node, names: string[]): void {
  if (
    node.type === "identifier" ||
    node.type === "property_identifier" ||
    node.type === "field_identifier" ||
    node.type === "method_identifier" ||
    node.type === "simple_identifier" ||
    node.type === "name" ||
    node.type === "constant"
  ) {
    names.push(node.text);
    return;
  }
  if (isArgumentContainer(node.type)) return;
  for (const child of node.namedChildren) collectIdentifierNames(child, names);
}

function isArgumentContainer(type: string): boolean {
  return type === "arguments" || type === "argument_list" || type === "value_arguments";
}

function isKnownCollectionMethod(name: string): boolean {
  return isSortMethod(name) || isTransformMethod(name) || isMembershipMethod(name);
}

function isSortMethod(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "sort" || normalized === "sorted";
}

function isTransformMethod(name: string): boolean {
  return ["filter", "map", "reduce", "some", "every"].includes(name.toLowerCase());
}

function isMembershipMethod(name: string): boolean {
  return ["includes", "indexof", "find", "findindex", "contains", "in_array"].includes(name.toLowerCase());
}

/** Check if a binary/comparison node has a structural membership operator (not in string content). */
function hasMembershipOperator(node: Node): boolean {
  for (const child of node.children) {
    if (child.type === "in" || child.text === "in") return true;
    if (
      child.type === "comparison_operator" ||
      child.type === "binary_expression" ||
      child.type === "binary_expression_inner"
    ) {
      if (hasMembershipOperator(child)) return true;
    }
  }
  return false;
}
