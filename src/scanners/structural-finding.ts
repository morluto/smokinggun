import {createHash} from "node:crypto";
import type {FindingV2, LocationV1} from "../protocol/index.js";

export const scannerId = "smokinggun.structural";
export const scannerVersion = "1.0.0";

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
  return extension.toLowerCase() in languageByExtension;
}

export function makeFinding(
  path: string,
  line: number,
  ruleId: string,
  severity: FindingV2["severity"],
  message: string,
  suggestion: string,
  assumptions: ReadonlyArray<string>,
): FindingV2 {
  const id = `sg_${createHash("sha256").update(`${path}\0${line}\0${ruleId}\0${message}`).digest("hex").slice(0, 16)}`;
  const location: LocationV1 = {path, startLine: line, startColumn: 0, endLine: line, endColumn: 1};
  return {
    schemaVersion: "smokinggun.finding.v2",
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

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}
