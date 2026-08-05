import {expect, it} from "vitest";
import {measureScaling} from "./scaling.js";

it("measures every declared input point and records candidate fits", async () => {
  const result = await measureScaling({
    schemaVersion: "footgun.workload.v1",
    command: [process.execPath, "-e", "process.exit(0)", "0"],
    cwd: ".",
    environment: {},
    inheritEnvironment: false,
    warmups: 0,
    repetitions: 1,
    timeoutMs: 2_000,
    inputSizeParameterization: {name: "items", values: [1, 2, 4], commandIndex: 3},
    requestedProfile: "local-exec",
    expectedArtifacts: [],
    behaviorChecks: [],
  }, {root: process.cwd()});
  expect("code" in result).toBe(false);
  if ("code" in result) return;
  expect(result.points).toHaveLength(3);
  expect(result.points.every((point) => point.status === "complete")).toBe(true);
  expect(result.models.length).toBeGreaterThan(0);
  expect(result.parameter).toBe("items");
});

it("rejects a parameter index that cannot be substituted", async () => {
  const result = await measureScaling({
    schemaVersion: "footgun.workload.v1",
    command: [process.execPath],
    cwd: ".",
    environment: {},
    inheritEnvironment: false,
    warmups: 0,
    repetitions: 1,
    timeoutMs: 100,
    inputSizeParameterization: {name: "items", values: [1], commandIndex: 2},
    requestedProfile: "local-exec",
    expectedArtifacts: [],
    behaviorChecks: [],
  }, {root: process.cwd()});
  expect("code" in result && result.code).toBe("scaling-command-index-invalid");
});
