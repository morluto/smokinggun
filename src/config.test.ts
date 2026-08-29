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
      expect(result.sourceProfile).toBe("runtime");
      expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("accepts scan profiles from configuration and the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const config = join(directory, "smokinggun.config.json");
    await writeFile(config, JSON.stringify({sourceProfile: "all"}), "utf8");
    const fromFile = await loadConfig({config, cwd: directory});
    const fromEnvironment = await loadConfig({cwd: directory}, {SMOKINGGUN_PROFILE: "all"});
    expect(isConfigFailure(fromFile)).toBe(false);
    expect(isConfigFailure(fromEnvironment)).toBe(false);
    if (!isConfigFailure(fromFile)) expect(fromFile.sourceProfile).toBe("all");
    if (!isConfigFailure(fromEnvironment)) expect(fromEnvironment.sourceProfile).toBe("all");
    expect(await loadConfig({cwd: directory}, {SMOKINGGUN_PROFILE: "everything"})).toMatchObject({
      _tag: "ConfigFailure",
      code: "invalid-environment",
    });
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
      JSON.stringify({cwd: ".", output: "artifacts/report.json"}),
      "utf8",
    );
    const result = await loadConfig({}, {XDG_CONFIG_HOME: join(directory, "missing-user-config")}, nested);
    expect(isConfigFailure(result)).toBe(false);
    if (!isConfigFailure(result)) {
      expect(result.cwd).toBe(directory);
      expect(result.output).toBe(join(directory, "artifacts", "report.json"));
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
    for (const field of ["cwd", "output"] as const) {
      const link = join(directory, `escape-${field}`);
      await symlink(outside, link, "dir");
      const value = {[field]: `escape-${field}`};
      await writeFile(join(directory, "smokinggun.config.json"), JSON.stringify(value), "utf8");
      const result = await loadConfig({}, {XDG_CONFIG_HOME: join(parent, "missing-user-config")}, nested);
      expect(result).toMatchObject({_tag: "ConfigFailure", code: "config-path-traversal"});
    }
  });

  it("allows user configuration to reference paths outside the XDG configuration directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const xdg = join(parent, "xdg");
    const userConfigDirectory = join(xdg, "smokinggun");
    const repository = join(parent, "repository");
    await mkdir(userConfigDirectory, {recursive: true});
    await mkdir(repository);
    await writeFile(
      join(userConfigDirectory, "config.json"),
      JSON.stringify({
        cwd: repository,
        output: join(repository, "report.json"),
      }),
      "utf8",
    );

    const result = await loadConfig({}, {XDG_CONFIG_HOME: xdg}, repository);

    expect(isConfigFailure(result)).toBe(false);
    if (!isConfigFailure(result)) {
      expect(result.cwd).toBe(repository);
      expect(result.output).toBe(join(repository, "report.json"));
    }
  });

  it("canonicalizes duplicate set-like configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "smokinggun-config-"));
    const duplicate = join(directory, "duplicate.json");
    const canonical = join(directory, "canonical.json");
    await writeFile(duplicate, JSON.stringify({exclude: ["dist", "dist", "node_modules"]}), "utf8");
    await writeFile(canonical, JSON.stringify({exclude: ["dist", "node_modules"]}), "utf8");
    const duplicateResult = await loadConfig({config: duplicate, cwd: directory});
    const canonicalResult = await loadConfig({config: canonical, cwd: directory});
    expect(isConfigFailure(duplicateResult)).toBe(false);
    expect(isConfigFailure(canonicalResult)).toBe(false);
    if (!isConfigFailure(duplicateResult) && !isConfigFailure(canonicalResult)) {
      expect(duplicateResult.exclude).toEqual(["dist", "node_modules"]);
      expect(duplicateResult.digest).toBe(canonicalResult.digest);
    }
  });
});
