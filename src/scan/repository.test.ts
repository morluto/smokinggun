import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {execPath} from "node:process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {scanRepository} from "./repository.js";

describe("repository scan seam", () => {
  it("scans a real temporary repository and preserves deterministic findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-"));
    try {
      await writeFile(
        join(root, "fixture.ts"),
        "for (const item of items) {\n  for (const other of items) work(other);\n}\n",
        "utf8",
      );
      const options = {configDigest: "b".repeat(64), maxFindings: 20};
      const first = await scanRepository(root, options);
      const second = await scanRepository(root, options);
      expect(first.findings.map((finding) => finding.id)).toEqual(second.findings.map((finding) => finding.id));
      expect(first.coverage[0]?.filesAnalyzed).toBe(1);
      expect(first.findings[0]?.location.path).toBe("fixture.ts");
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 30_000);

  it("reports bounded findings while retaining the full policy set", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-limit-"));
    try {
      await writeFile(
        join(root, "fixture.ts"),
        "for (const item of items) { for (const other of items) values.includes(other); }\n",
        "utf8",
      );
      const report = await scanRepository(root, {configDigest: "e".repeat(64), maxFindings: 1});
      expect(report.findingSummary).toEqual({total: 3, emitted: 1, truncated: true});
      expect(report.findings).toHaveLength(1);
      expect(report.policyFindings).toHaveLength(3);
      expect(JSON.parse(JSON.stringify(report))).not.toHaveProperty("policyFindings");
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("records repository inventory and invokes a configured adapter only through the versioned boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-adapter-"));
    try {
      await writeFile(join(root, "fixture.ts"), "for (const item of items) work(item);\n", "utf8");
      const script =
        "if (process.argv.includes('--version')) { console.log('fixture-adapter 1.0.0'); process.exit(0); } let input=''; process.stdin.on('data', chunk => input += chunk).on('end', () => { const request = JSON.parse(input); process.stdout.write(JSON.stringify({schemaVersion:'footgun.adapter-result.v1',requestId:request.requestId,state:'complete',findings:[{schemaVersion:'footgun.finding.v1',id:'fg_0123456789abcdef',scanner:'fixture-adapter',scannerVersion:'1.0.0',ruleId:'fixture-rule',language:'typescript',kind:'fixture',claimClass:'static-fact',severity:'low',confidence:'unknown',status:'unvalidated',relatedFindings:[],message:'Configured adapter evidence',suggestion:'Inspect the fixture evidence.',location:{path:'fixture.ts',startLine:1,startColumn:0,endLine:1,endColumn:1},assumptions:[],evidence:['fixture-adapter:fixture-rule'],complexity:{}}],coverage:[],diagnostics:[],rawArtifacts:[]})); });";
      const manifest = join(root, "adapter.json");
      await writeFile(
        manifest,
        JSON.stringify({
          schemaVersion: "footgun.adapter-manifest.v1",
          id: "fixture-adapter",
          version: "1.0.0",
          command: [execPath, "-e", script],
          capabilities: ["static-scan"],
          languages: ["typescript"],
          limits: {timeoutMs: 2_000, maxOutputBytes: 100_000, maxArtifactBytes: 10_000},
        }),
        "utf8",
      );
      const report = await scanRepository(root, {
        configDigest: "c".repeat(64),
        adapterManifests: [manifest],
        scanners: ["auto"],
        allowAdapterExecution: true,
      });
      expect(report.inventory?.languages).toContainEqual({language: "typescript", files: 1, extensions: [".ts"]});
      expect(report.findings.some((finding) => finding.scanner === "fixture-adapter")).toBe(true);
      expect(
        report.coverage.some(
          (record) => record.scanner === "footgun.adapter:fixture-adapter" && record.parseStatus === "complete",
        ),
      ).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("marks provenance dirty when analyzed source includes untracked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-provenance-"));
    try {
      execFileSync("git", ["init"], {cwd: root});
      await writeFile(join(root, "tracked.ts"), "export const tracked = 1;\n", "utf8");
      execFileSync("git", ["add", "tracked.ts"], {cwd: root});
      execFileSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
        {cwd: root},
      );
      await writeFile(join(root, "untracked.ts"), "export const untracked = 2;\n", "utf8");
      const report = await scanRepository(root, {configDigest: "d".repeat(64)});
      expect(report.repository.dirty).toBe(true);
      expect(report.inventory?.languages).toContainEqual({language: "typescript", files: 2, extensions: [".ts"]});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
