import type {Node} from "web-tree-sitter";
import {inspectWithTreeSitter, type ParseCoverage} from "../parsers/tree-sitter-runtime.js";
import {makeFinding} from "./structural.js";
import type {FindingV1} from "../protocol/index.js";

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
const membershipPattern =
  /(?:\.includes\s*\(|\.indexOf\s*\(|\.find(?:Index)?\s*\(|\bin_array\s*\(|\bcontains\s*\(|\bin\b)/i;
const sortPattern = /(?:\.sort\s*\(|\bsorted\s*\(|\bsort\s*\()/i;
const transformPattern = /\.(?:filter|map|reduce|some|every)\s*\(/i;

export type TreeStructuralResult = {
  readonly findings: ReadonlyArray<FindingV1>;
  readonly coverage: ParseCoverage;
};

/** Derive syntax findings from named Tree-sitter nodes, retaining the parser as the structural source of truth. */
export async function scanWithTreeSitter(
  path: string,
  source: string,
  signal?: AbortSignal,
): Promise<TreeStructuralResult> {
  const result = await inspectWithTreeSitter(path, source, (root) => collectFindings(root, path), signal);
  return {findings: result.value ?? [], coverage: result.coverage};
}

function collectFindings(root: Node, path: string): ReadonlyArray<FindingV1> {
  const findings: FindingV1[] = [];
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
          "high",
          "Tree-sitter found an iterative region inside another iterative region.",
          "Check whether indexing, grouping, batching, or a single-pass algorithm can remove repeated scans.",
          ["the inner iteration count depends on an outer iteration"],
        ),
      );
    if (
      loopDepth > 0 &&
      (callTypes.has(node.type) || node.type === "comparison_operator" || node.type === "binary_expression")
    ) {
      const text = node.text;
      if (membershipPattern.test(text))
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
      else if (sortPattern.test(text))
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
      else if (transformPattern.test(text))
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
    }
    for (const child of node.namedChildren) visit(child, currentDepth);
  };
  visit(root, 0);
  return findings;

  function add(finding: FindingV1): void {
    const key = `${finding.location.path}\0${finding.location.startLine}\0${finding.ruleId}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  }
}
