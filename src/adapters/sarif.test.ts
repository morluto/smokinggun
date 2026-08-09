import {describe, expect, it} from "vitest";
import {importSarif} from "./sarif.js";

describe("SARIF import boundary", () => {
  it("keeps third-party identity, fingerprints, invocation failures, and bounded properties", () => {
    const result = importSarif(
      {
        version: "2.1.0",
        runs: [
          {
            tool: {driver: {name: "semgrep", version: "1.2.3"}},
            invocations: [{executionSuccessful: false}],
            properties: {runOwner: "fixture"},
            results: [
              {
                ruleId: "python.lang.correctness",
                level: "warning",
                message: {text: "fixture finding"},
                fingerprints: {primary: "stable-fingerprint"},
                properties: {originalRule: "python.lang.correctness", untrustedValue: {nested: true}},
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: {uri: "src/example.py"},
                      region: {startLine: 4, startColumn: 2},
                    },
                  },
                ],
                relatedLocations: [{physicalLocation: {artifactLocation: {uri: "src/other.py"}}}],
                fixes: [{description: {text: "untrusted fix"}}],
              },
            ],
          },
        ],
      },
      "/repo",
      "a".repeat(64),
      "artifact://sha256/" + "b".repeat(64),
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.findings[0]).toMatchObject({
      scanner: "sarif:semgrep",
      scannerVersion: "1.2.3",
      ruleId: "python.lang.correctness",
      evidence: ['sarif:{"primary":"stable-fingerprint"}'],
      thirdParty: {properties: {originalRule: "python.lang.correctness", untrustedValue: {nested: true}}},
    });
    expect(result.rawArtifacts).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("sarif-invocation-failed");
    expect(result.coverage[0]?.parseStatus).toBe("partial");
    expect(result.filesModified).toEqual([]);
  });

  it("rejects absolute locations outside the repository and malformed versions without throwing", () => {
    const outside = importSarif(
      {
        version: "2.1.0",
        runs: [
          {
            tool: {driver: {name: "tool"}},
            results: [{locations: [{physicalLocation: {artifactLocation: {uri: "/other/file.ts"}}}]}],
          },
        ],
      },
      "/repo",
      "a".repeat(64),
    );
    expect("code" in outside).toBe(false);
    if (!("code" in outside))
      expect(outside.diagnostics.map((diagnostic) => diagnostic.code)).toContain("sarif-path-outside-root");
    if (!("code" in outside)) expect(outside.coverage[0]?.parseStatus).toBe("partial");
    const malformed = importSarif({version: "2.0.0", runs: []}, "/repo", "a".repeat(64));
    expect("code" in malformed && malformed.code).toBe("invalid-sarif");
  });

  it("counts unique result locations as analyzed files", () => {
    const result = importSarif(
      {
        version: "2.1.0",
        runs: [
          {
            tool: {driver: {name: "tool"}},
            results: [
              {
                message: {text: "first"},
                locations: [{physicalLocation: {artifactLocation: {uri: "src/example.ts"}, region: {startLine: 1}}}],
              },
              {
                message: {text: "second"},
                locations: [{physicalLocation: {artifactLocation: {uri: "src/example.ts"}, region: {startLine: 2}}}],
              },
            ],
          },
        ],
      },
      "/repo",
      "a".repeat(64),
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.findings).toHaveLength(2);
    expect(result.coverage[0]).toMatchObject({filesDiscovered: 1, filesAnalyzed: 1});
  });

  it("keeps a reused SARIF fingerprint distinct across locations and removes exact duplicates", () => {
    const result = importSarif(
      {
        version: "2.1.0",
        runs: [
          {
            tool: {driver: {name: "tool"}},
            results: [
              {
                ruleId: "same-rule",
                fingerprints: {primary: "shared"},
                locations: [{physicalLocation: {artifactLocation: {uri: "src/first.ts"}, region: {startLine: 1}}}],
              },
              {
                ruleId: "same-rule",
                fingerprints: {primary: "shared"},
                locations: [{physicalLocation: {artifactLocation: {uri: "src/second.ts"}, region: {startLine: 1}}}],
              },
              {
                ruleId: "same-rule",
                fingerprints: {primary: "shared"},
                locations: [{physicalLocation: {artifactLocation: {uri: "src/second.ts"}, region: {startLine: 1}}}],
              },
            ],
          },
        ],
      },
      "/repo",
      "a".repeat(64),
    );
    expect("code" in result).toBe(false);
    if ("code" in result) return;
    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((finding) => finding.id)).size).toBe(2);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("sarif-finding-duplicate");
  });
});
