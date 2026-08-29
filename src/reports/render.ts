import type {ScanReportV2} from "../protocol/index.js";
import {parseScanReport} from "../protocol/index.js";
import type {OutputFormat} from "../config.js";
import {toolIdentity} from "../tool-identity.js";

/** Render the normalized scan model without adding diagnostics to machine output. */
export function renderScanReport(report: ScanReportV2, format: OutputFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(report, null, 2)}\n`;
    case "markdown":
      return renderMarkdown(report);
    case "sarif":
      return `${JSON.stringify(toSarif(report), null, 2)}\n`;
    case "human":
      return renderHuman(report);
    default:
      return assertNever(format);
  }
}

/** Convert a scan report to SARIF while retaining SmokingGun evidence in properties. */
export function toSarif(report: ScanReportV2): Record<string, unknown> {
  const truncation = findingTruncation(report);
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: toolIdentity.name,
            version: report.tool.version,
            informationUri: "https://github.com/morluto/smokinggun",
          },
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.severity === "high" ? "error" : finding.severity === "medium" ? "warning" : "note",
          message: {text: finding.message},
          locations: [
            {
              physicalLocation: {
                artifactLocation: {uri: finding.location.path},
                region: {
                  startLine: finding.location.startLine,
                  startColumn: finding.location.startColumn + 1,
                  endLine: finding.location.endLine,
                  endColumn: finding.location.endColumn + 1,
                },
              },
            },
          ],
          fingerprints: {smokinggunFindingId: finding.id},
          properties: {
            confidence: finding.confidence,
            status: finding.status,
            claimClass: finding.claimClass,
            language: finding.language,
            kind: finding.kind,
            symbol: finding.symbol,
            relatedFindings: finding.relatedFindings,
            assumptions: finding.assumptions,
            evidence: finding.evidence,
            evidenceRecords: finding.evidenceRecords,
            thirdParty: finding.thirdParty,
            scanner: finding.scanner,
            scannerVersion: finding.scannerVersion,
            complexity: finding.complexity,
          },
        })),
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: report.diagnostics.map((diagnostic) => ({
              level: "warning",
              message: {text: diagnostic.message},
              properties: {code: diagnostic.code},
            })),
          },
        ],
        properties: {
          schemaVersion: report.schemaVersion,
          coverage: report.coverage,
          nextAction: report.nextAction,
          filesModified: report.filesModified,
          ...(truncation === undefined ? {} : {findingTruncation: truncation}),
        },
      },
    ],
  };
}

function renderMarkdown(report: ScanReportV2): string {
  const truncation = findingTruncation(report);
  const lines = [
    "# SmokingGun scan",
    "",
    `Root: \`${report.repository.root}\``,
    `Revision: ${report.repository.revision ?? "unknown"}`,
    `Dirty: ${report.repository.dirty}`,
    `Configuration digest: \`${report.configDigest}\``,
    `Findings: ${report.findings.length}`,
    ...(truncation === undefined ? [] : [`Finding output truncated: ${truncation.message}`]),
    ...(report.inventory === undefined
      ? []
      : [
          `Languages: ${report.inventory.languages.map((language) => `${language.language} (${language.files})`).join(", ") || "none"}`,
          `Manifests: ${report.inventory.manifests.join(", ") || "none"}`,
        ]),
    "",
  ];
  if (report.findings.length === 0) lines.push("No complexity candidates were found.", "");
  for (const finding of report.findings) {
    lines.push(
      `## ${finding.severity.toUpperCase()} ${finding.ruleId}`,
      "",
      `- Location: \`${finding.location.path}:${finding.location.startLine}\``,
      `- Scanner: ${finding.scanner} ${finding.scannerVersion}`,
      `- Language/kind: ${finding.language ?? "unknown"} / ${finding.kind ?? finding.ruleId}`,
      `- Claim class: ${finding.claimClass ?? "unknown"}`,
      `- Confidence: ${finding.confidence}`,
      `- Status: ${finding.status}`,
      `- Related findings: ${finding.relatedFindings.join(", ") || "none"}`,
      `- Finding: ${finding.message}`,
      `- Suggestion: ${finding.suggestion}`,
      `- Assumptions: ${finding.assumptions.join("; ") || "none"}`,
      `- Evidence: ${finding.evidence.join("; ") || "none"}`,
      `- Complexity: ${finding.complexity.current ?? "unknown"} → ${finding.complexity.expected ?? "unknown"}`,
      "",
    );
  }
  lines.push(
    "## Coverage",
    "",
    ...report.coverage.map(
      (record) =>
        `- ${record.scanner} ${record.language}: ${record.parseStatus}, ${record.filesAnalyzed}/${record.filesDiscovered} files${record.reason === undefined ? "" : ` (${record.reason})`}`,
    ),
    "",
  );
  lines.push("## Assumptions", "", ...report.assumptions.map((assumption) => `- ${assumption}`), "");
  lines.push(
    "## Next action",
    "",
    `- ${report.nextAction ?? "unknown"}`,
    `- Files modified: ${report.filesModified.join(", ") || "none"}`,
    "",
  );
  lines.push(
    "## Diagnostics",
    "",
    ...(report.diagnostics.length === 0
      ? ["- None"]
      : report.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`)),
    "",
  );
  lines.push(`Scan duration: ${report.timings.durationMs.toFixed(2)} ms`, "");
  return `${lines.join("\n")}\n`;
}

function renderHuman(report: ScanReportV2): string {
  const truncation = findingTruncation(report);
  const lines = [
    `SmokingGun scan: ${report.repository.root}`,
    `${report.findings.length} candidate${report.findings.length === 1 ? "" : "s"}; coverage ${report.coverage.map((entry) => entry.parseStatus).join(", ")}`,
    `Assumptions: ${report.assumptions.join("; ")}`,
    ...(truncation === undefined ? [] : [truncation.message]),
  ];
  for (const finding of report.findings)
    lines.push(
      `${finding.severity.padEnd(6)} ${finding.location.path}:${finding.location.startLine} ${finding.ruleId} (${finding.confidence}, ${finding.status})\n  ${finding.message}`,
    );
  if (report.findings.length === 0) lines.push("No complexity candidates were found.");
  if (report.diagnostics.length > 0) lines.push(`Diagnostics: ${report.diagnostics.length}`);
  return `${lines.join("\n")}\n`;
}

function findingTruncation(report: ScanReportV2): {readonly message: string} | undefined {
  const diagnostic = report.diagnostics.find((entry) => entry.code === "findings-truncated");
  return diagnostic === undefined ? undefined : {message: diagnostic.message};
}

export function parseReportArtifact(
  input: unknown,
): ScanReportV2 | {readonly _tag: "InvalidReport"; readonly message: string} {
  const result = parseScanReport(input);
  return "_tag" in result ? {_tag: "InvalidReport", message: result.detail ?? result.message} : result;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported output format: ${String(value)}`);
}
