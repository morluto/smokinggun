import {mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {execPath} from "node:process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {Protocol} from "../protocol/index.js";
import {scanRepository} from "./repository.js";
import {automaticScannerSelection, entireScanRoot, parseScanScope, parseScannerSelection} from "./selection.js";
import {
  adapterExecutionAuthorized,
  adapterExecutionNotAuthorized,
  noExternalAdapters,
  parseExternalAdapters,
} from "../scanners/external.js";

const defaultScanOptions = {
  selection: automaticScannerSelection(),
  scope: entireScanRoot(),
  adapters: noExternalAdapters(),
  adapterAuthorization: adapterExecutionNotAuthorized,
};

describe("repository scan seam", () => {
  it("scans a real temporary repository and preserves deterministic findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-"));
    try {
      await writeFile(
        join(root, "fixture.ts"),
        "for (const item of items) {\n  for (const other of items) work(other);\n}\n",
        "utf8",
      );
      const options = {...defaultScanOptions, configDigest: "b".repeat(64), maxFindings: 20};
      const first = await scanRepository(root, options);
      const second = await scanRepository(root, options);
      expect(first.report.findings.map((finding) => finding.id)).toEqual(
        second.report.findings.map((finding) => finding.id),
      );
      expect(first.report.coverage[0]?.filesAnalyzed).toBe(1);
      expect(first.report.findings[0]?.location.path).toBe("fixture.ts");
      expect(Protocol.scanReport.safeParse(first.report).success).toBe(true);
      for (const finding of first.report.findings)
        expect(finding.relatedFindings).toEqual([...finding.relatedFindings].sort());
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
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "e".repeat(64), maxFindings: 1});
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "findings-truncated"}));
      expect(result.report.findings).toHaveLength(1);
      expect(result.policyFindings).toHaveLength(3);
      expect(result.report.findings[0]?.relatedFindings).toEqual([]);
      expect(Protocol.scanReport.safeParse(result.report).success).toBe(true);
      expect(JSON.parse(JSON.stringify(result.report))).not.toHaveProperty("policyFindings");
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("coalesces coverage for manifests with an ambiguous adapter identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-duplicate-adapter-"));
    try {
      await writeFile(join(root, "fixture.ts"), "export const value = 1;\n", "utf8");
      const manifest = (path: string) =>
        writeFile(
          path,
          JSON.stringify({
            schemaVersion: "footgun.adapter-manifest.v1",
            id: "duplicate-adapter",
            version: "1.0.0",
            command: [execPath, "--version"],
            capabilities: ["static-scan"],
            limits: {timeoutMs: 1_000, maxOutputBytes: 1_000, maxArtifactBytes: 1_000},
          }),
          "utf8",
        );
      const first = join(root, "first-adapter.json");
      const second = join(root, "second-adapter.json");
      await Promise.all([manifest(first), manifest(second)]);
      const adapters = await parseExternalAdapters([first, second], root);
      const result = await scanRepository(root, {
        ...defaultScanOptions,
        adapters,
        configDigest: "e".repeat(64),
      });
      expect(
        result.report.coverage.filter((record) => record.scanner === "footgun.adapter:duplicate-adapter"),
      ).toHaveLength(1);
      expect(result.report.diagnostics.filter((diagnostic) => diagnostic.code === "duplicate-adapter-id")).toHaveLength(
        2,
      );
      expect(Protocol.scanReport.safeParse(result.report).success).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("records repository inventory and invokes a configured adapter only through the versioned boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-adapter-"));
    try {
      await writeFile(join(root, "fixture.ts"), "for (const item of items) work(item);\n", "utf8");
      const script =
        "if (process.argv.includes('--version')) { console.log('fixture-adapter 1.0.0'); process.exit(0); } let input=''; process.stdin.on('data', chunk => input += chunk).on('end', () => { const request = JSON.parse(input); process.stdout.write(JSON.stringify({schemaVersion:'footgun.adapter-result.v2',requestId:request.requestId,state:'complete',findings:[{schemaVersion:'footgun.finding.v2',id:'fg_0123456789abcdef',scanner:'fixture-adapter',scannerVersion:'1.0.0',ruleId:'fixture-rule',language:'typescript',kind:'fixture',claimClass:'static-fact',severity:'low',confidence:'unknown',status:'unvalidated',relatedFindings:[],message:'Configured adapter evidence',suggestion:'Inspect the fixture evidence.',location:{path:'fixture.ts',startLine:1,startColumn:0,endLine:1,endColumn:1},assumptions:[],evidence:['fixture-adapter:fixture-rule'],complexity:{}}],coverage:[],diagnostics:[],rawArtifacts:[]})); });";
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
      const adapters = await parseExternalAdapters([manifest], root);
      const result = await scanRepository(root, {
        configDigest: "c".repeat(64),
        ...defaultScanOptions,
        adapters,
        adapterAuthorization: adapterExecutionAuthorized,
      });
      expect(result.report.inventory?.languages).toContainEqual({
        language: "typescript",
        files: 1,
        extensions: [".ts"],
      });
      expect(result.report.findings.some((finding) => finding.scanner === "fixture-adapter")).toBe(true);
      expect(
        result.report.coverage.some(
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
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "d".repeat(64)});
      expect(result.report.repository.dirty).toBe(true);
      expect(result.report.inventory?.languages).toContainEqual({
        language: "typescript",
        files: 2,
        extensions: [".ts"],
      });
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("keeps TypeScript semantic findings within the selected --only files", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-only-"));
    try {
      await writeFile(join(root, "a.ts"), 'import {run} from "./b"; export {run};\n', "utf8");
      await writeFile(
        join(root, "b.ts"),
        "export function run(values: string[]) { for (const value of values) fetch(value); }\n",
        "utf8",
      );
      const scope = parseScanScope(["a.ts"]);
      if ("schemaVersion" in scope) throw new Error(scope.message);
      const result = await scanRepository(root, {
        ...defaultScanOptions,
        configDigest: "d".repeat(64),
        selection: automaticScannerSelection(),
        scope,
      });
      expect(result.report.inventory?.languages).toContainEqual({
        language: "typescript",
        files: 1,
        extensions: [".ts"],
      });
      expect(result.report.findings.every((finding) => finding.location.path === "a.ts")).toBe(true);
      expect(result.report.context?.files).toEqual(["a.ts"]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("reports skipped source symlinks as incomplete coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-symlink-"));
    try {
      await writeFile(join(root, "normal.ts"), "export const value = 1;\n", "utf8");
      await symlink("normal.ts", join(root, "linked.ts"));
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "d".repeat(64)});
      expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 2, filesAnalyzed: 1, parseStatus: "partial"});
      expect(result.report.coverage[0]?.skippedFiles).toContain("linked.ts");
      expect(result.report.diagnostics).toContainEqual(
        expect.objectContaining({code: "symlink-skipped", path: "linked.ts"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("treats an unmatched explicit scope as incomplete coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-scope-"));
    try {
      await writeFile(join(root, "fixture.ts"), "export const value = 1;\n", "utf8");
      const scope = parseScanScope(["missing"]);
      if ("schemaVersion" in scope) throw new Error(scope.message);
      const result = await scanRepository(root, {
        ...defaultScanOptions,
        configDigest: "d".repeat(64),
        selection: automaticScannerSelection(),
        scope,
      });
      expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 0, filesAnalyzed: 0, parseStatus: "partial"});
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "scan-scope-unmatched"}));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("matches path filters only against paths inside the scan root", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-root-relative-"));
    try {
      await writeFile(join(root, "fixture.ts"), "export const value = 1;\n", "utf8");
      const scope = parseScanScope(["tmp"]);
      if ("schemaVersion" in scope) throw new Error(scope.message);
      const result = await scanRepository(root, {
        ...defaultScanOptions,
        configDigest: "d".repeat(64),
        selection: automaticScannerSelection(),
        scope,
      });
      expect(result.report.inventory?.languages).toEqual([]);
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "scan-scope-unmatched"}));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("reports skipped directory symlinks as incomplete coverage without following them", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-directory-symlink-"));
    try {
      const sourceDirectory = join(root, "source");
      await mkdir(sourceDirectory);
      await writeFile(join(sourceDirectory, "fixture.py"), "for item in values:\n  item in values\n", "utf8");
      await symlink("source", join(root, "linked-source"));
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "d".repeat(64)});
      expect(result.report.coverage[0]).toMatchObject({parseStatus: "partial"});
      expect(result.report.coverage[0]?.skippedFiles).toContain("linked-source");
      expect(result.report.diagnostics).toContainEqual(
        expect.objectContaining({code: "symlink-skipped", path: "linked-source"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("rejects a symlink passed as the scan root before traversing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-scan-root-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "footgun-scan-outside-"));
    try {
      await writeFile(join(outside, "outside.ts"), "export const outside = true;\n", "utf8");
      const link = join(root, "linked-root");
      await symlink(outside, link);
      await expect(scanRepository(link, {...defaultScanOptions, configDigest: "d".repeat(64)})).rejects.toThrow(
        "scan root cannot be a symlink",
      );
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  it("accepts canonical scanner IDs and emits coverage only for selected backends", async () => {
    const pythonSelection = parseScannerSelection(["footgun.python-semantic"], []);
    if ("schemaVersion" in pythonSelection) throw new Error(pythonSelection.message);
    const pythonResult = await scanRepository("fixtures/corpus/python", {
      ...defaultScanOptions,
      configDigest: "d".repeat(64),
      selection: pythonSelection,
      scope: entireScanRoot(),
    });
    expect(pythonResult.report.findings.some((finding) => finding.scanner === "footgun.python-semantic")).toBe(true);
    expect(pythonResult.report.coverage.some((record) => record.scanner === "footgun.python-semantic")).toBe(true);
    expect(
      pythonResult.report.coverage.some(
        (record) => record.scanner === "footgun.structural" || record.scanner === "footgun.tree-sitter",
      ),
    ).toBe(false);

    const structuralSelection = parseScannerSelection(["footgun.structural"], []);
    if ("schemaVersion" in structuralSelection) throw new Error(structuralSelection.message);
    const structuralResult = await scanRepository("fixtures/corpus/typescript", {
      ...defaultScanOptions,
      configDigest: "d".repeat(64),
      selection: structuralSelection,
      scope: entireScanRoot(),
    });
    expect(structuralResult.report.coverage.some((record) => record.scanner === "footgun.typescript-semantic")).toBe(
      false,
    );
    expect(structuralResult.report.diagnostics.some((diagnostic) => diagnostic.code === "scanner-skipped")).toBe(false);
  });
});
