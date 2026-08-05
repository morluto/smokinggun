import {createHash} from "node:crypto";
import {isAbsolute, normalize, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import type {ScanReportV1, FindingV1, ProtocolProblemV1} from "../protocol/index.js";
import {comparePortable, portablePath} from "../paths.js";
import {stableJson} from "../serialization.js";

const sarifLocation = z.looseObject({physicalLocation: z.looseObject({artifactLocation: z.looseObject({uri: z.string().optional()}).optional(), region: z.looseObject({startLine: z.number().optional(), startColumn: z.number().optional(), endLine: z.number().optional(), endColumn: z.number().optional()}).optional()}).optional()});
const sarifResult = z.looseObject({ruleId: z.string().optional(), level: z.string().optional(), message: z.looseObject({text: z.string().optional()}).optional(), locations: z.array(sarifLocation).optional(), fingerprints: z.record(z.string(), z.string()).optional(), properties: z.record(z.string(), z.unknown()).optional(), relatedLocations: z.array(sarifLocation).optional(), fixes: z.array(z.unknown()).optional()});
const sarifInvocation = z.looseObject({executionSuccessful: z.boolean().optional(), toolExecutionNotifications: z.array(z.unknown()).optional()});
const sarifRun = z.looseObject({tool: z.looseObject({driver: z.looseObject({name: z.string().optional(), version: z.string().optional()})}), results: z.array(sarifResult).optional(), invocations: z.array(sarifInvocation).optional(), properties: z.record(z.string(), z.unknown()).optional()});
const sarifDocument = z.looseObject({version: z.string(), runs: z.array(sarifRun)});

/** Import SARIF as untrusted third-party evidence while preserving tool identity and rule IDs. */
export function importSarif(input: unknown, root: string, configDigest: string, rawArtifact?: string): ScanReportV1 | ProtocolProblemV1 {
  const parsed = sarifDocument.safeParse(input);
  if (!parsed.success || parsed.data.version !== "2.1.0") return {schemaVersion: "footgun.problem.v1", _tag: "ProtocolProblem", code: "invalid-sarif", message: "The artifact is not SARIF 2.1.0.", recovery: "Pass a SARIF 2.1.0 document or generate one with `footgun scan --format sarif`."};
  const findings: FindingV1[] = [];
  const diagnostics: ScanReportV1["diagnostics"] = [];
  const scannerNames: string[] = [];
  for (const [runIndex, run] of parsed.data.runs.entries()) {
    const driver = run.tool.driver;
    const scanner = driver.name ?? "sarif-tool";
    scannerNames.push(scanner);
    if (run.invocations?.some((invocation) => invocation.executionSuccessful === false)) diagnostics.push({schemaVersion: "footgun.problem.v1", code: "sarif-invocation-failed", message: `SARIF run ${runIndex} reported an unsuccessful invocation.`, recovery: "Inspect the preserved SARIF artifact before treating imported findings as complete."});
    for (const [resultIndex, result] of (run.results ?? []).entries()) {
      const location = result.locations?.[0]?.physicalLocation;
      const path = location?.artifactLocation?.uri;
      if (location === undefined || path === undefined) {
        diagnostics.push({schemaVersion: "footgun.problem.v1", code: "sarif-location-missing", message: `SARIF result ${runIndex}:${resultIndex} has no primary location.`, recovery: "Re-run the external scanner with file locations enabled."});
        continue;
      }
      const portablePath = normalizeSarifPath(path, root);
      if (portablePath === undefined) {
        diagnostics.push({schemaVersion: "footgun.problem.v1", code: "sarif-path-outside-root", message: `SARIF result ${runIndex}:${resultIndex} is outside the repository boundary.`, recovery: "Regenerate SARIF with repository-relative artifact URIs."});
        continue;
      }
      const region = location.region;
      const line = Math.max(1, region?.startLine ?? 1);
      const fingerprint = result.fingerprints === undefined ? `${path}\0${line}\0${resultIndex}` : stableJson(result.fingerprints);
      const id = `fg_${createHash("sha256").update(`${scanner}\0${result.ruleId ?? "unknown"}\0${fingerprint}`).digest("hex").slice(0, 16)}`;
      const thirdParty = capProperties({properties: result.properties, relatedLocations: result.relatedLocations, fixes: result.fixes, runProperties: run.properties});
      findings.push({
        schemaVersion: "footgun.finding.v1",
        id,
        scanner: `sarif:${scanner}`,
        scannerVersion: driver.version ?? "unknown",
        ruleId: result.ruleId ?? "unknown",
        severity: result.level === "error" ? "high" : result.level === "warning" ? "medium" : "info",
        confidence: "unknown",
        status: "unvalidated",
        relatedFindings: [],
        message: result.message?.text ?? "External SARIF result.",
        suggestion: "Inspect the external rule documentation and validate this result independently.",
        location: {path: portablePath, startLine: line, startColumn: Math.max(0, (region?.startColumn ?? 1) - 1), endLine: Math.max(line, region?.endLine ?? line), endColumn: Math.max(0, (region?.endColumn ?? region?.startColumn ?? 1) - 1)},
        assumptions: ["SARIF was imported as third-party evidence; Footgun did not independently verify the rule."],
        evidence: [result.fingerprints === undefined ? `sarif:${runIndex}:${resultIndex}` : `sarif:${JSON.stringify(result.fingerprints)}`],
        complexity: {},
        ...(thirdParty === undefined ? {} : {thirdParty}),
      });
    }
  }
  findings.sort((left, right) => comparePortable(left.location.path, right.location.path) || left.location.startLine - right.location.startLine || comparePortable(left.id, right.id));
  return {
    schemaVersion: "footgun.scan-report.v1",
    tool: {name: "footgun", version: "1.0.0"},
    repository: {root: ".", revision: null, dirty: false},
    configDigest,
    findings,
    coverage: [{scanner: "footgun.sarif-import", version: "1.0.0", language: "mixed", filesDiscovered: new Set(findings.map((finding) => finding.location.path)).size, filesAnalyzed: findings.length, parseStatus: "complete", skippedFiles: [], reason: scannerNames.length === 0 ? "SARIF contained no runs." : `Imported ${scannerNames.join(", ")}.`}],
    diagnostics,
    timings: {startedAt: new Date().toISOString(), durationMs: 0},
    assumptions: ["Imported third-party SARIF results are evidence references, not independent Footgun findings."],
    filesModified: [],
    rawArtifacts: rawArtifact === undefined ? [] : [rawArtifact],
  };
}

function normalizeSarifPath(path: string, root: string): string | undefined {
  const candidate = (path.startsWith("file://") ? fileURLToPath(path) : path).replace(/\\/g, "/");
  if (isAbsolute(candidate)) {
    const relativePath = relative(resolve(root), resolve(candidate));
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return undefined;
    return portablePath(relativePath);
  }
  const normalized = portablePath(normalize(candidate));
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

function capProperties(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const present = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  if (Object.keys(present).length === 0) return undefined;
  const serialized = JSON.stringify(present);
  if (serialized.length <= 32_768) return present;
  return {truncated: true, digest: createHash("sha256").update(serialized).digest("hex")};
}
