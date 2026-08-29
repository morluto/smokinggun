import {mkdir, mkdtemp, symlink, truncate, writeFile} from "node:fs/promises";
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

  it("rejects oversized configuration before parsing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const config = join(directory, "smokinggun.config.json");
    await writeFile(config, "{}", "utf8");
    await truncate(config, 1024 * 1024 + 1);

    const result = await loadConfig({config, cwd: directory});

    expect(result).toMatchObject({_tag: "ConfigFailure", code: "config-read-failed"});
    if (isConfigFailure(result)) expect(result.detail).toContain("1048576 byte limit");
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

  it("bounds auto-discovered paths to the config project root, not the invocation subdirectory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const nested = join(directory, "packages", "example");
    await mkdir(nested, {recursive: true});
    await writeFile(
      join(directory, "smokinggun.config.json"),
      JSON.stringify({cwd: ".", output: "artifacts/report.json", adapters: ["adapters/example.json"]}),
      "utf8",
    );
    const result = await loadConfig({}, {XDG_CONFIG_HOME: join(directory, "missing-user-config")}, nested);
    expect(isConfigFailure(result)).toBe(false);
    if (!isConfigFailure(result)) {
      expect(result.cwd).toBe(directory);
      expect(result.output).toBe(join(directory, "artifacts", "report.json"));
      expect(result.adapters).toEqual([join(directory, "adapters", "example.json")]);
    }
  });

  it("rejects an auto-discovered path that escapes the config project root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const directory = join(parent, "repository");
    const nested = join(directory, "src");
    await mkdir(nested, {recursive: true});
    await writeFile(join(directory, "smokinggun.config.json"), JSON.stringify({output: "../report.json"}), "utf8");
    const result = await loadConfig({}, {XDG_CONFIG_HOME: join(parent, "missing-user-config")}, nested);
    expect(result).toMatchObject({_tag: "ConfigFailure", code: "config-path-traversal"});
  });

  it("rejects auto-discovered config paths that escape through symlinks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const directory = join(parent, "repository");
    const nested = join(directory, "src");
    const outside = join(parent, "outside");
    await mkdir(nested, {recursive: true});
    await mkdir(outside);
    for (const field of ["cwd", "output", "adapters"] as const) {
      const link = join(directory, `escape-${field}`);
      await symlink(outside, link, "dir");
      const value = field === "adapters" ? {[field]: [`escape-${field}/adapter.json`]} : {[field]: `escape-${field}`};
      await writeFile(join(directory, "smokinggun.config.json"), JSON.stringify(value), "utf8");
      const result = await loadConfig({}, {XDG_CONFIG_HOME: join(parent, "missing-user-config")}, nested);
      expect(result).toMatchObject({_tag: "ConfigFailure", code: "config-path-traversal"});
    }
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
