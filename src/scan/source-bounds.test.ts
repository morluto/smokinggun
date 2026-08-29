import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {scanRepository} from "./repository.js";
import {automaticScannerSelection, entireScanRoot} from "./selection.js";

it("makes bounded traversal visible in every applicable coverage claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-source-bounds-"));
  try {
    await writeFile(join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(root, "b.ts"), "export const b = 2;\n", "utf8");

    const result = await scanRepository(root, {
      configDigest: "d".repeat(64),
      selection: automaticScannerSelection(),
      scope: entireScanRoot(),
      sourceCaptureLimits: {
        maxFiles: 1,
        maxDirectories: 10,
        maxDepth: 10,
        maxFileBytes: 1_024,
        maxTotalBytes: 4_096,
      },
    });

    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "source-traversal-bounded"}));
    expect(result.report.coverage.length).toBeGreaterThan(0);
    expect(result.report.coverage.every((coverage) => coverage.parseStatus !== "complete")).toBe(true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("makes depth-bounded traversal visible instead of reporting an unmatched clean scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-source-bounds-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "a.ts"), "export const a = 1;\n", "utf8");

    const result = await scanRepository(root, {
      configDigest: "d".repeat(64),
      selection: automaticScannerSelection(),
      scope: entireScanRoot(),
      sourceCaptureLimits: {
        maxFiles: 10,
        maxDirectories: 10,
        maxDepth: 0,
        maxFileBytes: 1_024,
        maxTotalBytes: 4_096,
      },
    });

    expect(result.report.diagnostics).toContainEqual(
      expect.objectContaining({code: "source-traversal-bounded", detail: expect.stringContaining("depth")}),
    );
    expect(result.report.diagnostics).not.toContainEqual(expect.objectContaining({code: "scan-scope-unmatched"}));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("reserves the source-file bound for runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-source-bounds-profile-"));
  try {
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "docs", "guide.ts"), "export const guide = 1;\n", "utf8");
    await writeFile(join(root, "src", "runtime.ts"), "for (const value of values) values.includes(value);\n", "utf8");

    const result = await scanRepository(root, {
      configDigest: "d".repeat(64),
      selection: automaticScannerSelection(),
      scope: entireScanRoot(),
      sourceCaptureLimits: {
        maxFiles: 1,
        maxDirectories: 10,
        maxDepth: 10,
        maxFileBytes: 1_024,
        maxTotalBytes: 4_096,
      },
    });

    expect(result.report.findings.every((finding) => finding.location.path === "src/runtime.ts")).toBe(true);
    expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 1, filesAnalyzed: 1});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("reserves the directory bound for runtime directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-source-bounds-profile-"));
  try {
    await mkdir(join(root, "docs"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "docs", "guide.ts"), "export const guide = 1;\n", "utf8");
    await writeFile(join(root, "src", "runtime.ts"), "for (const value of values) values.includes(value);\n", "utf8");

    const result = await scanRepository(root, {
      configDigest: "d".repeat(64),
      selection: automaticScannerSelection(),
      scope: entireScanRoot(),
      sourceCaptureLimits: {
        maxFiles: 10,
        maxDirectories: 2,
        maxDepth: 10,
        maxFileBytes: 1_024,
        maxTotalBytes: 4_096,
      },
    });

    expect(result.report.findings.every((finding) => finding.location.path === "src/runtime.ts")).toBe(true);
    expect(result.report.coverage[0]).toMatchObject({filesDiscovered: 1, filesAnalyzed: 1});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("keeps depth bounds local to an auxiliary branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-source-bounds-profile-"));
  try {
    await mkdir(join(root, "docs", "deep"), {recursive: true});
    await mkdir(join(root, "src"));
    await writeFile(join(root, "docs", "deep", "guide.ts"), "export const guide = 1;\n", "utf8");
    await writeFile(join(root, "src", "runtime.ts"), "for (const value of values) values.includes(value);\n", "utf8");

    const result = await scanRepository(root, {
      configDigest: "d".repeat(64),
      selection: automaticScannerSelection(),
      scope: entireScanRoot(),
      sourceCaptureLimits: {
        maxFiles: 10,
        maxDirectories: 10,
        maxDepth: 1,
        maxFileBytes: 1_024,
        maxTotalBytes: 4_096,
      },
    });

    expect(result.report.findings.every((finding) => finding.location.path === "src/runtime.ts")).toBe(true);
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({code: "source-traversal-bounded"}));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
