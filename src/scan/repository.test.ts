import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {Protocol} from "../protocol/index.js";
import {toSarif} from "../reports/render.js";
import {scanRepository} from "./repository.js";
import {automaticScannerSelection, entireScanRoot, parseScanScope, parseScannerSelection} from "./selection.js";

const defaultScanOptions = {
  selection: automaticScannerSelection(),
  scope: entireScanRoot(),
};

describe("repository scan seam", () => {
  it("scans a real temporary repository and preserves deterministic findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-"));
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

  it("reports one partial-parse diagnostic for each incomplete tree-sitter parse", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-partial-parse-"));
    try {
      await writeFile(join(root, "broken.ts"), "export function broken( {\n", "utf8");

      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "a".repeat(64)});
      const diagnostics = result.report.diagnostics.filter(
        (diagnostic) => diagnostic.code === "partial-parse" && diagnostic.path === "broken.ts",
      );

      expect(diagnostics).toHaveLength(1);
      expect(result.report.coverage).toContainEqual(
        expect.objectContaining({scanner: "smokinggun.tree-sitter", parseStatus: "partial"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("discovers C++ source and header extensions supported by the pinned grammar", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-cpp-"));
    try {
      await writeFile(join(root, "example.cxx"), "int main() { return 0; }\n", "utf8");
      await writeFile(join(root, "example.hh"), "int example();\n", "utf8");

      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "c".repeat(64)});

      expect(result.report.inventory?.languages).toContainEqual({
        language: "cpp",
        files: 2,
        extensions: [".cxx", ".hh"],
      });
      expect(result.report.coverage).toContainEqual(
        expect.objectContaining({
          scanner: "smokinggun.tree-sitter",
          language: "cpp",
          filesDiscovered: 2,
          filesAnalyzed: 2,
        }),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("reports bounded findings while retaining the full policy set", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-limit-"));
    try {
      await writeFile(
        join(root, "fixture.ts"),
        "for (const item of items) { for (const other of items) values.includes(other); }\n",
        "utf8",
      );
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "e".repeat(64), maxFindings: 1});
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "findings-truncated"}));
      expect(result.report.findings).toHaveLength(1);
      expect(result.policyFindings.length).toBeGreaterThanOrEqual(2);
      expect(result.report.findings[0]?.relatedFindings).toEqual([]);
      expect(Protocol.scanReport.safeParse(result.report).success).toBe(true);
      expect(JSON.parse(JSON.stringify(result.report))).not.toHaveProperty("policyFindings");
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("keeps bounded findings representative across top-level repository areas", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-representative-"));
    try {
      await mkdir(join(root, "benchmarks"), {recursive: true});
      await mkdir(join(root, "src"), {recursive: true});
      await writeFile(
        join(root, "benchmarks", "many.ts"),
        "for (const left of values) { for (const right of values) values.includes(right); values.sort(); }\n",
        "utf8",
      );
      await writeFile(join(root, "src", "product.ts"), "for (const value of values) values.includes(value);\n", "utf8");
      const result = await scanRepository(root, {...defaultScanOptions, maxFindings: 2});
      expect(result.report.findings.map((finding) => finding.location.path.split("/")[0])).toEqual([
        "benchmarks",
        "src",
      ]);
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "findings-truncated"}));
      expect(result.policyFindings.length).toBeGreaterThan(result.report.findings.length);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("suppresses auxiliary source from runtime findings without hiding it from inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-"));
    try {
      await mkdir(join(root, "docs"));
      await mkdir(join(root, "src"));
      await mkdir(join(root, "tests"));
      const candidate = "for (const value of values) values.includes(value);\n";
      await writeFile(join(root, "docs", "conf.py"), "for value in values:\n    value in values\n", "utf8");
      await writeFile(join(root, "src", "product.ts"), candidate, "utf8");
      await writeFile(join(root, "src", "product.test.ts"), candidate, "utf8");
      await writeFile(join(root, "tests", "product.ts"), candidate, "utf8");

      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "e".repeat(64)});

      expect(result.report.findings.map((finding) => finding.location.path)).toEqual([
        "src/product.ts",
        "src/product.ts",
      ]);
      expect(result.report.inventory?.tests).toEqual(["src/product.test.ts", "tests/product.ts"]);
      expect(result.report.diagnostics).toContainEqual(
        expect.objectContaining({code: "auxiliary-source-suppressed", message: expect.stringContaining("3")}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("keeps SARIF successful when auxiliary suppression is the only diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-sarif-"));
    try {
      await mkdir(join(root, "src"));
      await mkdir(join(root, "tests"));
      await writeFile(join(root, "src", "product.go"), "package product\nfunc Run() {}\n", "utf8");
      await writeFile(join(root, "tests", "product.go"), "package tests\nfunc TestRun() {}\n", "utf8");

      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "e".repeat(64)});

      expect(result.report.diagnostics).toEqual([expect.objectContaining({code: "auxiliary-source-suppressed"})]);
      expect(result.report.coverage.every((record) => record.parseStatus === "complete")).toBe(true);
      expect(toSarif(result.report)).toMatchObject({runs: [{invocations: [{executionSuccessful: true}]}]});
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("scans auxiliary source with the all profile or an explicit path scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-"));
    try {
      await mkdir(join(root, "tests"));
      await writeFile(
        join(root, "tests", "product.ts"),
        "for (const value of values) values.includes(value);\n",
        "utf8",
      );

      const all = await scanRepository(root, {
        ...defaultScanOptions,
        configDigest: "e".repeat(64),
        profile: "all",
      });
      const explicitScope = parseScanScope(["tests"]);
      if ("schemaVersion" in explicitScope) throw new Error(explicitScope.message);
      const explicit = await scanRepository(root, {
        ...defaultScanOptions,
        configDigest: "e".repeat(64),
        scope: explicitScope,
      });

      expect(all.report.findings.length).toBeGreaterThan(0);
      expect(explicit.report.findings.length).toBeGreaterThan(0);
      expect(all.report.diagnostics).not.toContainEqual(expect.objectContaining({code: "auxiliary-source-suppressed"}));
      expect(explicit.report.diagnostics).not.toContainEqual(
        expect.objectContaining({code: "auxiliary-source-suppressed"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it.each([".ts", "language:typescript"])("keeps runtime filtering for %s scopes", async (filter) => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-filter-"));
    try {
      await mkdir(join(root, "tests"));
      await writeFile(join(root, "src.ts"), "for (const value of values) values.includes(value);\n", "utf8");
      await writeFile(
        join(root, "tests", "src.test.ts"),
        "for (const value of values) values.includes(value);\n",
        "utf8",
      );
      const scope = parseScanScope([filter]);
      if ("schemaVersion" in scope) throw new Error(scope.message);
      const result = await scanRepository(root, {...defaultScanOptions, scope});

      expect(result.report.findings.every((finding) => finding.location.path === "src.ts")).toBe(true);
      expect(result.report.inventory?.tests).toEqual(["tests/src.test.ts"]);
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "auxiliary-source-suppressed"}));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("applies path overrides only to auxiliary files under the selected path", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-path-"));
    try {
      await mkdir(join(root, "docs"));
      await mkdir(join(root, "src"));
      const candidate = "for (const value of values) values.includes(value);\n";
      await writeFile(join(root, "docs", "guide.ts"), candidate, "utf8");
      await writeFile(join(root, "src", "product.test.ts"), candidate, "utf8");
      const scope = parseScanScope(["docs", ".ts"]);
      if ("schemaVersion" in scope) throw new Error(scope.message);

      const result = await scanRepository(root, {...defaultScanOptions, scope});

      expect(result.report.findings.every((finding) => finding.location.path === "docs/guide.ts")).toBe(true);
      expect(result.report.inventory?.tests).toEqual(["src/product.test.ts"]);
      expect(result.report.diagnostics).toContainEqual(
        expect.objectContaining({code: "auxiliary-source-suppressed", message: expect.stringContaining("1")}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("keeps newly recognized test names in inventory when runtime scanning suppresses them", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-inventory-"));
    try {
      const candidate = "for (const value of values) values.includes(value);\n";
      for (const file of [
        "foo_test.go",
        "test_foo.py",
        "TestFoo.java",
        "FooTests.cs",
        "CacheTestCase.java",
        "conftest.py",
      ])
        await writeFile(join(root, file), candidate, "utf8");

      const result = await scanRepository(root, defaultScanOptions);

      expect(result.report.findings).toEqual([]);
      expect(result.report.inventory?.tests).toEqual([
        "CacheTestCase.java",
        "FooTests.cs",
        "TestFoo.java",
        "conftest.py",
        "foo_test.go",
        "test_foo.py",
      ]);
      expect(result.report.diagnostics).toContainEqual(
        expect.objectContaining({code: "auxiliary-source-suppressed", message: expect.stringContaining("6")}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("does not report an unmatched scope when the runtime profile suppresses its auxiliary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-filter-"));
    try {
      await writeFile(join(root, "only.test.ts"), "for (const value of values) values.includes(value);\n", "utf8");
      const scope = parseScanScope([".ts"]);
      if ("schemaVersion" in scope) throw new Error(scope.message);
      const result = await scanRepository(root, {...defaultScanOptions, scope});

      expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 0, parseStatus: "complete"});
      expect(result.report.diagnostics).not.toContainEqual(expect.objectContaining({code: "scan-scope-unmatched"}));
      expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "auxiliary-source-suppressed"}));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("honors an explicitly selected auxiliary source file", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-profile-"));
    try {
      const path = join(root, "product.test.ts");
      await writeFile(path, "for (const value of values) values.includes(value);\n", "utf8");

      const result = await scanRepository(path, {...defaultScanOptions, configDigest: "e".repeat(64)});

      expect(result.report.findings.length).toBeGreaterThan(0);
      expect(result.report.diagnostics).not.toContainEqual(
        expect.objectContaining({code: "auxiliary-source-suppressed"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it.skipIf(process.platform === "win32")("marks unreadable source files as incomplete coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-unreadable-"));
    const unreadable = join(root, "unreadable.ts");
    try {
      await writeFile(join(root, "readable.ts"), "export const value = 1;\n", "utf8");
      await writeFile(unreadable, "export const value = 2;\n", "utf8");
      await chmod(unreadable, 0o000);
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "e".repeat(64)});
      expect(result.report.coverage[0]).toMatchObject({
        filesDiscovered: 2,
        filesAnalyzed: 1,
        parseStatus: "partial",
        skippedFiles: ["unreadable.ts"],
      });
      expect(result.report.coverage[0]?.reason).toContain("could not be read");
      expect(result.report.coverage).toContainEqual(
        expect.objectContaining({
          scanner: "smokinggun.tree-sitter",
          language: "typescript",
          filesDiscovered: 2,
          filesAnalyzed: 1,
          parseStatus: "unavailable",
          skippedFiles: ["unreadable.ts"],
        }),
      );
      expect(result.report.coverage).toContainEqual(
        expect.objectContaining({
          scanner: "smokinggun.typescript-semantic",
          filesDiscovered: 2,
          filesAnalyzed: 1,
          parseStatus: "partial",
          skippedFiles: ["unreadable.ts"],
        }),
      );
      expect(Protocol.scanReport.safeParse(result.report).success).toBe(true);
    } finally {
      await chmod(unreadable, 0o600).catch(() => undefined);
      await rm(root, {recursive: true, force: true});
    }
  });

  it.skipIf(process.platform === "win32")("counts unreadable Python files before semantic scanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-unreadable-python-"));
    const unreadable = join(root, "unreadable.py");
    try {
      await writeFile(unreadable, "value = 1\n", "utf8");
      await chmod(unreadable, 0o000);
      const selection = parseScannerSelection(["smokinggun.python-semantic"]);
      if ("schemaVersion" in selection) throw new Error(selection.message);
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "e".repeat(64), selection});
      expect(result.report.coverage).toContainEqual(
        expect.objectContaining({
          scanner: "smokinggun.python-semantic",
          filesDiscovered: 1,
          filesAnalyzed: 0,
          parseStatus: "unavailable",
          skippedFiles: ["unreadable.py"],
        }),
      );
      expect(Protocol.scanReport.safeParse(result.report).success).toBe(true);
    } finally {
      await chmod(unreadable, 0o600).catch(() => undefined);
      await rm(root, {recursive: true, force: true});
    }
  });

  it("marks provenance dirty when analyzed source includes untracked files", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-provenance-"));
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

  it("keeps snapshot-backed TypeScript semantic coverage within the selected --only files", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-only-"));
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
      expect(result.report.context).toBeUndefined();
      expect(result.report.coverage).toContainEqual(
        expect.objectContaining({
          scanner: "smokinggun.typescript-semantic",
          filesDiscovered: 1,
          filesAnalyzed: 1,
          parseStatus: "partial",
        }),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("reports skipped source symlinks as incomplete coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-symlink-"));
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

  it("does not retain auxiliary source symlinks in runtime coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-symlink-profile-"));
    try {
      await mkdir(join(root, "tests"));
      await writeFile(join(root, "normal.ts"), "export const value = 1;\n", "utf8");
      await symlink("../normal.ts", join(root, "tests", "linked.ts"));
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "d".repeat(64)});

      expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 1, filesAnalyzed: 1, parseStatus: "complete"});
      expect(result.report.coverage[0]?.skippedFiles).not.toContain("tests/linked.ts");
      expect(result.report.diagnostics).not.toContainEqual(
        expect.objectContaining({code: "symlink-skipped", path: "tests/linked.ts"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("counts suppressed auxiliary symlinks as matched scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-symlink-profile-scope-"));
    try {
      await mkdir(join(root, "tests"));
      await writeFile(join(root, "normal.ts"), "export const value = 1;\n", "utf8");
      await symlink("../normal.ts", join(root, "tests", "linked.ts"));
      const scope = parseScanScope([".ts"]);
      if ("schemaVersion" in scope) throw new Error(scope.message);

      const result = await scanRepository(root, {...defaultScanOptions, scope});

      expect(result.report.diagnostics).not.toContainEqual(expect.objectContaining({code: "scan-scope-unmatched"}));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("treats an unmatched explicit scope as incomplete coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-scope-"));
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
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-root-relative-"));
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
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-directory-symlink-"));
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

  it("does not retain auxiliary directory symlinks in runtime coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-directory-symlink-profile-"));
    const outside = await mkdtemp(join(tmpdir(), "smokinggun-scan-directory-symlink-profile-target-"));
    try {
      await writeFile(join(root, "normal.ts"), "export const value = 1;\n", "utf8");
      await writeFile(join(outside, "fixture.ts"), "export const value = 2;\n", "utf8");
      await symlink(outside, join(root, "tests"));
      const result = await scanRepository(root, {...defaultScanOptions, configDigest: "d".repeat(64)});

      expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 1, filesAnalyzed: 1, parseStatus: "complete"});
      expect(result.report.coverage[0]?.skippedFiles).not.toContain("tests");
      expect(result.report.diagnostics).not.toContainEqual(
        expect.objectContaining({code: "symlink-skipped", path: "tests"}),
      );
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(outside, {recursive: true, force: true});
    }
  });

  it("rejects a symlink passed as the scan root before traversing its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-scan-root-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "smokinggun-scan-outside-"));
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
    const pythonSelection = parseScannerSelection(["smokinggun.python-semantic"]);
    if ("schemaVersion" in pythonSelection) throw new Error(pythonSelection.message);
    const pythonResult = await scanRepository("fixtures/corpus/python", {
      ...defaultScanOptions,
      configDigest: "d".repeat(64),
      selection: pythonSelection,
      scope: entireScanRoot(),
    });
    expect(pythonResult.report.findings.some((finding) => finding.scanner === "smokinggun.python-semantic")).toBe(true);
    expect(pythonResult.report.coverage).toContainEqual(
      expect.objectContaining({scanner: "smokinggun.python-semantic", parseStatus: "complete"}),
    );
    expect(
      pythonResult.report.coverage.some(
        (record) => record.scanner === "smokinggun.structural" || record.scanner === "smokinggun.tree-sitter",
      ),
    ).toBe(false);

    const structuralSelection = parseScannerSelection(["smokinggun.structural"]);
    if ("schemaVersion" in structuralSelection) throw new Error(structuralSelection.message);
    const structuralResult = await scanRepository("fixtures/corpus/typescript", {
      ...defaultScanOptions,
      configDigest: "d".repeat(64),
      selection: structuralSelection,
      scope: entireScanRoot(),
    });
    expect(structuralResult.report.coverage.some((record) => record.scanner === "smokinggun.typescript-semantic")).toBe(
      false,
    );
    expect(structuralResult.report.diagnostics.some((diagnostic) => diagnostic.code === "scanner-skipped")).toBe(false);
  });
});
