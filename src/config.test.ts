import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {isConfigFailure, loadConfig} from "./config.js";

describe("configuration", () => {
  it("rejects unknown JSON configuration keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const config = join(directory, "smokinggun.config.json");
    await writeFile(config, JSON.stringify({wat: true}), "utf8");
    const result = await loadConfig({config, cwd: directory});
    expect(isConfigFailure(result)).toBe(true);
  });

  it("normalizes a valid explicit configuration and computes a digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const config = join(directory, "smokinggun.config.json");
    await writeFile(config, JSON.stringify({format: "json", maxFindings: 12}), "utf8");
    const result = await loadConfig({config, cwd: directory});
    expect(isConfigFailure(result)).toBe(false);
    if (!isConfigFailure(result)) {
      expect(result.format).toBe("json");
      expect(result.maxFindings).toBe(12);
      expect(result.failOn).toBeUndefined();
      expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("accepts the fail-on policy from the environment", async () => {
    const result = await loadConfig({cwd: process.cwd()}, {SMOKINGGUN_FAIL_ON: "high"});
    expect(isConfigFailure(result)).toBe(false);
    if (!isConfigFailure(result)) expect(result.failOn).toBe("high");
  });

  it("resolves file paths relative to the defining config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const nested = join(directory, "nested");
    const config = join(nested, "smokinggun.config.json");
    await mkdir(nested);
    await writeFile(config, JSON.stringify({output: "artifacts/report.json"}), "utf8");
    const result = await loadConfig({config, cwd: directory});
    expect(isConfigFailure(result)).toBe(false);
    if (!isConfigFailure(result)) expect(result.output).toBe(join(nested, "artifacts/report.json"));
  });

  it("canonicalizes duplicate set-like configuration and rejects empty path entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const duplicate = join(directory, "duplicate.json");
    const canonical = join(directory, "canonical.json");
    await writeFile(
      duplicate,
      JSON.stringify({exclude: ["dist", "dist", "node_modules"], adapters: ["adapter.json", "adapter.json"]}),
      "utf8",
    );
    await writeFile(canonical, JSON.stringify({exclude: ["dist", "node_modules"], adapters: ["adapter.json"]}), "utf8");
    const duplicateResult = await loadConfig({config: duplicate, cwd: directory});
    const canonicalResult = await loadConfig({config: canonical, cwd: directory});
    expect(isConfigFailure(duplicateResult)).toBe(false);
    expect(isConfigFailure(canonicalResult)).toBe(false);
    if (!isConfigFailure(duplicateResult) && !isConfigFailure(canonicalResult)) {
      expect(duplicateResult.exclude).toEqual(["dist", "node_modules"]);
      expect(duplicateResult.adapters).toEqual([join(directory, "adapter.json")]);
      expect(duplicateResult.digest).toBe(canonicalResult.digest);
    }
    const invalid = join(directory, "invalid.json");
    await writeFile(invalid, JSON.stringify({adapters: [""]}), "utf8");
    expect(isConfigFailure(await loadConfig({config: invalid, cwd: directory}))).toBe(true);
  });
});
