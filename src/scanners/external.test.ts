import {access, mkdtemp, rm, writeFile} from "node:fs/promises";
import {execPath} from "node:process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {loadExternalAdapters} from "./external.js";

it("blocks network-capable adapters before capability probing", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-adapter-policy-"));
  try {
    const manifest = join(root, "network.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: "footgun.adapter-manifest.v1",
        id: "network-adapter",
        version: "1.0.0",
        command: [execPath, "-e", "process.exit(1)"],
        capabilities: ["network"],
        sideEffects: ["execute", "network"],
        limits: {timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000},
      }),
      "utf8",
    );
    const result = await loadExternalAdapters([manifest], root, undefined, true);
    const descriptor = result.descriptors[0];
    expect(descriptor?.availability).toBe("unavailable");
    if (descriptor?.availability === "unavailable") expect(descriptor.reason).toContain("Network-capable");
    expect(result.diagnostics[0]?.code).toBe("adapter-network-blocked");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("does not execute adapter probes without explicit authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-adapter-policy-"));
  try {
    const marker = join(root, "marker");
    const manifest = join(root, "adapter.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: "footgun.adapter-manifest.v1",
        id: "untrusted-adapter",
        version: "1.0.0",
        command: [execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
        capabilities: ["static-scan"],
        limits: {timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000},
      }),
      "utf8",
    );
    const result = await loadExternalAdapters([manifest], root);
    const descriptor = result.descriptors[0];
    expect(descriptor?.availability).toBe("unavailable");
    if (descriptor?.availability === "unavailable") expect(descriptor.reason).toContain("explicit authorization");
    expect(result.diagnostics[0]?.code).toBe("adapter-execution-required");
    await expect(access(marker)).rejects.toMatchObject({code: "ENOENT"});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
