import {createHash} from "node:crypto";
import type {FindingV1, LocationV1} from "../protocol/index.js";

export const scannerId = "footgun.structural";
export const scannerVersion = "1.0.0";

const textExtensions = new Set([
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".swift",
]);

const loopPattern = /\b(for|foreach|while)\b/;
const callbackLoopPattern = /\.(?:forEach|each|map|filter|reduce|some|every)\s*\(/i;
const membershipPattern =
  /(\.includes\s*\(|\.indexOf\s*\(|\.find\s*\(|\.findIndex\s*\(|\bin_array\s*\(|\bcontains\s*\(|\bin\s+)/i;
const sortPattern = /(\.sort\s*\(|\bsorted\s*\(|\bsort\s*\()/i;
const queryPattern = /\b(fetch|axios\.|request|query|execute|findMany|findOne|findUnique|select|where)\s*\(/i;
const componentPattern = /\b(function\s+[A-Z][A-Za-z0-9_]*|export\s+default\s+function\s+[A-Z])/;
const languageByExtension: Readonly<Record<string, string>> = {
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".kt": "kotlin",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescript",
};

export function isSupportedExtension(extension: string): boolean {
  return textExtensions.has(extension.toLowerCase());
}

export function scanSource(
  path: string,
  text: string,
): {
  readonly findings: ReadonlyArray<FindingV1>;
  readonly parseStatus: "complete" | "partial";
  readonly reason?: string;
} {
  const lines = text.split(/\r?\n/);
  const findings: FindingV1[] = [];
  const extension = extensionOf(path);
  const python = extension === ".py";
  const masked = maskRegexLiterals(
    maskCommentsAndStrings(text, python, [".py", ".rb", ".php"].includes(extension)),
  ).split(/\r?\n/);
  const functionNames = functionNamesIn(masked);
  const componentRanges = componentLineRanges(masked);
  const activeLoops: Array<{readonly depth: number}> = [];
  let braceDepth = 0;
  let parseError = false;

  for (let index = 0; index < masked.length; index += 1) {
    const sourceLine = lines[index] ?? "";
    const line = masked[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      braceDepth += braceDelta(line);
      continue;
    }
    const indentation = sourceLine.length - sourceLine.trimStart().length;
    while (activeLoops.length > 0) {
      const current = activeLoops[activeLoops.length - 1];
      if (current === undefined) break;
      const stillNested = python ? indentation > current.depth : braceDepth >= current.depth;
      if (stillNested) break;
      activeLoops.pop();
    }

    const hasLoop = loopPattern.test(line) || callbackLoopPattern.test(line);
    if (hasLoop && activeLoops.length > 0) {
      findings.push(
        makeFinding(
          path,
          index + 1,
          "nested-or-callback-loop",
          "high",
          "Loop or array iteration appears inside another iterative region.",
          "Check whether indexing, grouping, batching, or a single-pass algorithm can remove repeated scans.",
          ["the inner iteration count depends on an outer iteration"],
        ),
      );
    }
    if (activeLoops.length > 0 && /\.(filter|map)\s*\(/.test(line)) {
      findings.push(
        makeFinding(
          path,
          index + 1,
          "repeated-scan",
          "medium",
          "Collection transform appears inside iterative code and may rescan a collection.",
          "Consider precomputing an index/grouping or combining passes.",
          ["the transform may traverse a collection once per enclosing iteration"],
        ),
      );
    }
    if (activeLoops.length > 0 && membershipPattern.test(line)) {
      const isKnownConstant = /\b(new\s+Set|new\s+Map|set\s*\(|dict\s*\(|frozenset\s*\()/i.test(line);
      if (!isKnownConstant) {
        findings.push(
          makeFinding(
            path,
            index + 1,
            "membership-in-loop",
            "medium",
            "Membership/search operation appears inside iterative code.",
            "Consider a Set/Map or precomputed lookup if equality and ordering semantics allow it.",
            python && /\b(list|tuple)\b/.test(line)
              ? ["right-hand collection appears list-like"]
              : ["right-hand collection type and size are unknown"],
          ),
        );
      }
    }
    if (activeLoops.length > 0 && sortPattern.test(line)) {
      findings.push(
        makeFinding(
          path,
          index + 1,
          "sort-in-loop",
          "high",
          "Sorting inside iterative code is often avoidable repeated O(n log n) work.",
          "Move sorting out of the loop or use a heap/binary-search strategy if intermediate order is needed.",
          ["sort cost depends on collection size"],
        ),
      );
    }
    if (activeLoops.length > 0 && queryPattern.test(line)) {
      findings.push(
        makeFinding(
          path,
          index + 1,
          "io-or-query-in-loop",
          "high",
          "Potential database/API/file operation inside a loop.",
          "Look for N+1 behavior; batch or preload while preserving auth, filters, ordering, and error handling.",
          ["the call may execute once per enclosing iteration; caching and batching were not inspected"],
        ),
      );
    }
    if (componentRanges.has(index + 1) && /\.(filter|map|sort|reduce)\s*\(/.test(line)) {
      findings.push(
        makeFinding(
          path,
          index + 1,
          "render-derived-work",
          "medium",
          "Collection transform appears in a likely UI component render path.",
          "For large collections, consider memoized selectors, server-side derivation, or virtualization.",
          ["the function appears to be a UI component"],
        ),
      );
    }
    for (const name of functionNames) {
      const isDefinition =
        new RegExp(`\\b(?:function|def|func|fn)\\s+${escapeRegExp(name)}\\b`).test(line) ||
        new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`).test(line);
      if (!isDefinition && new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(line)) {
        findings.push(
          makeFinding(
            path,
            index + 1,
            "recursive-call",
            "medium",
            "Function calls itself; runtime may depend on recursion depth and repeated subproblems.",
            "Identify the decreasing input measure and recurrence, then test stack depth and overlapping-state behavior.",
            ["recursive input measure and branching behavior were not inferred"],
          ),
        );
      }
    }

    const delta = braceDelta(line);
    if (delta < 0 && braceDepth + delta < 0) parseError = true;
    braceDepth += delta;
    if (hasLoop) activeLoops.push({depth: python ? indentation : braceDepth});
  }
  if (!python && braceDepth !== 0) parseError = true;
  return parseError
    ? {
        findings: dedupeFindings(findings),
        parseStatus: "partial",
        reason: "Unbalanced delimiters prevented complete structural coverage.",
      }
    : {findings: dedupeFindings(findings), parseStatus: "complete"};
}

export function makeFinding(
  path: string,
  line: number,
  ruleId: string,
  severity: FindingV1["severity"],
  message: string,
  suggestion: string,
  assumptions: ReadonlyArray<string>,
): FindingV1 {
  const id = `fg_${createHash("sha256").update(`${path}\0${line}\0${ruleId}\0${message}`).digest("hex").slice(0, 16)}`;
  const location: LocationV1 = {path, startLine: line, startColumn: 0, endLine: line, endColumn: 1};
  return {
    schemaVersion: "footgun.finding.v1",
    id,
    scanner: scannerId,
    scannerVersion,
    ruleId,
    language: languageByExtension[extensionOf(path)] ?? "unknown",
    kind: ruleId,
    claimClass: "theoretical-estimate",
    severity,
    confidence: "candidate",
    status: "unvalidated",
    relatedFindings: [],
    message,
    suggestion,
    location,
    assumptions: [...assumptions],
    evidence: [`${scannerId}:${ruleId}`],
    complexity:
      ruleId === "sort-in-loop"
        ? {current: "O(n log n) per iteration", expected: "one sort or ordered lookup"}
        : {current: "repeated iteration", expected: "indexed or batched access"},
  };
}

function dedupeFindings(findings: ReadonlyArray<FindingV1>): ReadonlyArray<FindingV1> {
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      if (seen.has(finding.id)) return false;
      seen.add(finding.id);
      return true;
    })
    .sort(compareFindings);
}

function compareFindings(left: FindingV1, right: FindingV1): number {
  if (left.location.path !== right.location.path) return left.location.path < right.location.path ? -1 : 1;
  if (left.location.startLine !== right.location.startLine) return left.location.startLine - right.location.startLine;
  if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function maskCommentsAndStrings(input: string, python: boolean, hashComments: boolean): string {
  const output = [...input];
  let quote: string | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index] ?? "";
    const next = output[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n" || current === "\r") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        output[index] = " ";
        output[index + 1] = " ";
        index += 1;
        blockComment = false;
      } else if (current !== "\n" && current !== "\r") output[index] = " ";
      continue;
    }
    if (quote !== undefined) {
      if (quote.length === 3 && input.slice(index, index + 3) === quote) {
        output[index] = " ";
        output[index + 1] = " ";
        output[index + 2] = " ";
        index += 2;
        quote = undefined;
        continue;
      }
      if (current === "\\") {
        output[index] = " ";
        if (output[index + 1] !== undefined && output[index + 1] !== "\n") output[index + 1] = " ";
        index += 1;
      } else if (current === quote) {
        quote = undefined;
        output[index] = " ";
      } else if (current !== "\n" && current !== "\r") output[index] = " ";
      continue;
    }
    const hashComment = hashComments && current === "#";
    if ((current === "/" && next === "/") || hashComment) {
      output[index] = " ";
      if (current === "/") {
        output[index + 1] = " ";
        index += 1;
      }
      lineComment = true;
    } else if (current === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      blockComment = true;
    } else if (python && (input.slice(index, index + 3) === '"""' || input.slice(index, index + 3) === "'''")) {
      quote = input.slice(index, index + 3);
      output[index] = " ";
      output[index + 1] = " ";
      output[index + 2] = " ";
      index += 2;
    } else if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output[index] = " ";
    }
  }
  return output.join("");
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === "{") delta += 1;
    if (character === "}") delta -= 1;
  }
  return delta;
}

function maskRegexLiterals(input: string): string {
  return input.replace(/\/(?:\\.|[^/\n\\])+\/[dgimsuvy]*/g, (match) => match.replace(/[^\n]/g, " "));
}

function functionNamesIn(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const match = line.match(/\b(?:function|def|func|fn)\s+([A-Za-z_$][\w$]*)/);
    if (match?.[1] !== undefined) names.add(match[1]);
    const arrow = line.match(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    );
    if (arrow?.[1] !== undefined) names.add(arrow[1]);
  }
  return [...names];
}

function componentLineRanges(lines: ReadonlyArray<string>): Set<number> {
  const result = new Set<number>();
  let active = false;
  let remaining = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (componentPattern.test(line)) {
      active = true;
      remaining = 120;
    }
    if (active) {
      result.add(index + 1);
      remaining -= 1;
      if (remaining <= 0) active = false;
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}
