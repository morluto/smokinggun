import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {adapterExecutionNotAuthorized, noExternalAdapters} from "../scanners/external.js";
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
      adapters: noExternalAdapters(),
      adapterAuthorization: adapterExecutionNotAuthorized,
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
      adapters: noExternalAdapters(),
      adapterAuthorization: adapterExecutionNotAuthorized,
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
