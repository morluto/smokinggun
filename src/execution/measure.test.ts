import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {expect, it} from "vitest";
import {measureWorkload} from "./measure.js";

it("records repeated timing and validates explicit behavior checks", async () => {
  const stdoutDigest = createHash("sha256").update("ok").digest("hex");
  const result = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath, "-e", "process.stdout.write('ok')"],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 1,
      repetitions: 2,
      timeoutMs: 2_000,
      requestedProfile: "local-exec",
      expectedArtifacts: [],
      behaviorChecks: ["exit-code:0", `stdout-sha256:${stdoutDigest}`],
    },
    {root: process.cwd()},
  );
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.samplesMs).toHaveLength(2);
  expect(result.behaviorValidated).toBe(true);
  expect(result.behaviorChecks?.every((check) => check.passed)).toBe(true);
});

it("rejects workload cwd escapes and runner-free container profiles at the parsing boundary", async () => {
  const escaped = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath],
      cwd: "..",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 100,
      requestedProfile: "local-exec",
      expectedArtifacts: [],
      behaviorChecks: [],
    },
    {root: process.cwd()},
  );
  const isolated = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 100,
      requestedProfile: "container-exec",
      expectedArtifacts: [],
      behaviorChecks: [],
    },
    {root: process.cwd()},
  );
  expect("code" in escaped && escaped.code).toBe("invalid-workload");
  expect("code" in isolated && isolated.code).toBe("invalid-workload");
  const readOnly = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 100,
      requestedProfile: "read-only",
      expectedArtifacts: [],
      behaviorChecks: [],
    },
    {root: process.cwd()},
  );
  expect("code" in readOnly && readOnly.code).toBe("execution-profile-unavailable");
});

it("rejects unsupported resource controls at the workload boundary", async () => {
  const result = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath, "-e", "process.exit(0)"],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 100,
      requestedProfile: "local-exec",
      expectedArtifacts: [],
      behaviorChecks: [],
      resourceLimits: {memoryBytes: 1_000_000, maxProcesses: 1},
    },
    {root: process.cwd()},
  );
  expect("code" in result && result.code).toBe("invalid-workload");
});

it("records a redacted reproduction contract and rejects artifact escapes at the parsing boundary", async () => {
  const result = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath, "-e", "process.stdout.write('ok')", "--", "--token", "secret-value"],
      cwd: ".",
      environment: {SMOKINGGUN_TEST_TOKEN: "not-recorded"},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 2_000,
      requestedProfile: "local-exec",
      expectedArtifacts: [],
      behaviorChecks: ["exit-code:0"],
    },
    {root: process.cwd()},
  );
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.reproduction.command).toContain("--token");
  expect(result.reproduction.command).toContain("[REDACTED]");
  expect(result.reproduction.command).not.toContain("secret-value");
  expect(result.reproduction.environmentKeys).toContain("SMOKINGGUN_TEST_TOKEN");
  expect(result.reproduction.environmentKeys).not.toContain("CAAS_ARTIFACTORY_READER_PASSWORD");

  const escaped = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 100,
      requestedProfile: "local-exec",
      expectedArtifacts: ["../outside.json"],
      behaviorChecks: [],
    },
    {root: process.cwd()},
  );
  expect("code" in escaped && escaped.code).toBe("invalid-workload");
});

it.skipIf(!existsSync("/usr/bin/bwrap"))("runs an explicitly selected workload through bubblewrap", async () => {
  const result = await measureWorkload(
    {
      schemaVersion: "footgun.workload.v2",
      command: [process.execPath, "-e", "process.stdout.write('sandboxed')"],
      cwd: ".",
      environment: {},
      inheritEnvironment: false,
      warmups: 0,
      repetitions: 1,
      timeoutMs: 2_000,
      requestedProfile: "container-exec",
      runner: {runtime: "bwrap"},
      expectedArtifacts: [],
      behaviorChecks: ["stdout-sha256:" + createHash("sha256").update("sandboxed").digest("hex")],
    },
    {root: process.cwd()},
  );
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.isolation.backend).toBe("bwrap");
  expect(result.isolation.controlsApplied).toContain("filesystem-read-only");
});

it("runs candidate-write in a copied workspace and leaves the source tree untouched", async () => {
  const source = await mkdtemp(join(tmpdir(), "footgun-candidate-source-"));
  const artifacts = await mkdtemp(join(tmpdir(), "footgun-candidate-artifacts-"));
  try {
    await writeFile(join(source, "input.txt"), "source", "utf8");
    const result = await measureWorkload(
      {
        schemaVersion: "footgun.workload.v2",
        command: [process.execPath, "-e", "require('node:fs').writeFileSync('output.txt','candidate')"],
        cwd: ".",
        environment: {},
        inheritEnvironment: false,
        warmups: 0,
        repetitions: 1,
        timeoutMs: 2_000,
        requestedProfile: "candidate-write",
        expectedArtifacts: ["output.txt"],
        behaviorChecks: ["exit-code:0"],
      },
      {root: source, workspaceRoot: artifacts},
    );
    expect("code" in result).toBe(false);
    if (!("code" in result)) {
      expect(result.isolation.controlsApplied).toContain("candidate-workspace");
      expect(result.behaviorValidated).toBe(true);
    }
    expect(await readFile(join(source, "input.txt"), "utf8")).toBe("source");
    expect(existsSync(join(source, "output.txt"))).toBe(false);
  } finally {
    await rm(source, {recursive: true, force: true});
    await rm(artifacts, {recursive: true, force: true});
  }
});

it("rejects a workload cwd symlink that escapes the repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-workload-root-"));
  const outside = await mkdtemp(join(tmpdir(), "footgun-workload-outside-"));
  try {
    await symlink(outside, join(root, "linked"));
    const result = await measureWorkload(
      {
        schemaVersion: "footgun.workload.v2",
        command: [process.execPath, "-e", "process.exit(0)"],
        cwd: "linked",
        environment: {},
        inheritEnvironment: false,
        warmups: 0,
        repetitions: 1,
        timeoutMs: 2_000,
        requestedProfile: "local-exec",
        expectedArtifacts: [],
        behaviorChecks: [],
      },
      {root},
    );
    expect(result).toMatchObject({code: "workload-boundary-violation"});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});
