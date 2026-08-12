import {access, mkdtemp, rm, writeFile} from "node:fs/promises";
import {execPath} from "node:process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {Protocol} from "../protocol/index.js";
import {
  adapterExecutionAuthorized,
  adapterExecutionNotAuthorized,
  loadExternalAdapters,
  parseExternalAdapters,
} from "./external.js";

it("blocks network-capable adapters before capability probing", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-policy-"));
  try {
    const manifest = join(root, "network.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: "smokinggun.adapter-manifest.v1",
        id: "network-adapter",
        version: "1.0.0",
        command: [execPath, "-e", "process.exit(1)"],
        capabilities: ["network"],
        sideEffects: ["execute", "network"],
        limits: {timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000},
      }),
      "utf8",
    );
    const result = await loadExternalAdapters([manifest], root, {authorization: adapterExecutionAuthorized});
    const descriptor = result.descriptors[0];
    expect(descriptor?.availability).toBe("unavailable");
    if (descriptor?.availability === "unavailable") expect(descriptor.reason).toContain("Network-capable");
    expect(result.diagnostics[0]?.code).toBe("adapter-network-blocked");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("does not execute adapter probes without explicit authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-policy-"));
  try {
    const marker = join(root, "marker");
    const manifest = join(root, "adapter.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: "smokinggun.adapter-manifest.v1",
        id: "untrusted-adapter",
        version: "1.0.0",
        command: [execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
        capabilities: ["static-scan"],
        limits: {timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000},
      }),
      "utf8",
    );
    const result = await loadExternalAdapters([manifest], root, {authorization: adapterExecutionNotAuthorized});
    const descriptor = result.descriptors[0];
    expect(descriptor?.availability).toBe("unavailable");
    if (descriptor?.availability === "unavailable") expect(descriptor.reason).toContain("explicit authorization");
    expect(result.diagnostics[0]?.code).toBe("adapter-execution-required");
    await expect(access(marker)).rejects.toMatchObject({code: "ENOENT"});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("rejects every manifest in an ambiguous adapter identity group", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-policy-"));
  try {
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    const manifest = (command: string[]) =>
      JSON.stringify({
        schemaVersion: "smokinggun.adapter-manifest.v1",
        id: "duplicate-adapter",
        version: "1.0.0",
        command,
        capabilities: ["static-scan"],
        limits: {timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000},
      });
    await writeFile(first, manifest([execPath, "--version"]), "utf8");
    await writeFile(second, manifest([execPath, "--version"]), "utf8");
    const result = await parseExternalAdapters([first, second], root);
    expect(result.adapters).toEqual([]);
    expect(result.invalidDescriptors).toHaveLength(2);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === "duplicate-adapter-id")).toBe(true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("does not expose host paths for an invalid manifest outside the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-root-"));
  const external = await mkdtemp(join(tmpdir(), "smokinggun-adapter-external-"));
  try {
    const manifest = join(external, "invalid.json");
    await writeFile(manifest, "{", "utf8");
    const result = await parseExternalAdapters([manifest], root);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.code).toBe("adapter-manifest-read-failed");
    expect(diagnostic?.path).toBeUndefined();
    expect(diagnostic?.message).not.toContain(external);
    expect(diagnostic?.detail).not.toContain(external);
    expect(result.invalidDescriptors[0]?.manifestPath).toBe("the supplied external manifest");
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(external, {recursive: true, force: true});
  }
});

it("identifies an unreadable manifest at the repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-root-manifest-"));
  try {
    const result = await parseExternalAdapters([root], root);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic).toMatchObject({code: "adapter-manifest-read-failed", path: "."});
    expect(Protocol.problem.safeParse(diagnostic).success).toBe(true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
