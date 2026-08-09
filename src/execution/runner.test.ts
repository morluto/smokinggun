import {expect, it} from "vitest";
import {executeWorkload} from "./runner.js";

it("represents process completion and timeout as exclusive outcomes", async () => {
  const complete = await executeWorkload(workload("process.stdout.write('ok')", 2_000), {
    root: process.cwd(),
    cwd: process.cwd(),
  });
  expect("code" in complete).toBe(false);
  if ("code" in complete) return;
  expect(complete).toMatchObject({outcome: "completed", exitCode: 0, stdout: "ok"});
  expect("timedOut" in complete).toBe(false);
  expect("isCanceled" in complete).toBe(false);

  const timedOut = await executeWorkload(workload("setTimeout(() => {}, 1_000)", 20), {
    root: process.cwd(),
    cwd: process.cwd(),
  });
  expect("code" in timedOut).toBe(false);
  if ("code" in timedOut) return;
  expect(timedOut.outcome).toBe("timed-out");
  expect("exitCode" in timedOut).toBe(false);
});

it("represents an aborted workload as a cancelled outcome", async () => {
  const controller = new AbortController();
  const execution = executeWorkload(workload("setTimeout(() => {}, 1_000)", 2_000), {
    root: process.cwd(),
    cwd: process.cwd(),
    signal: controller.signal,
  });
  controller.abort();

  const cancelled = await execution;
  expect("code" in cancelled).toBe(false);
  if ("code" in cancelled) return;
  expect(cancelled.outcome).toBe("cancelled");
  expect("exitCode" in cancelled).toBe(false);
});

function workload(script: string, timeoutMs: number) {
  return {
    schemaVersion: "footgun.workload.v2" as const,
    command: [process.execPath, "-e", script],
    cwd: ".",
    environment: {},
    inheritEnvironment: false,
    warmups: 0,
    repetitions: 1,
    timeoutMs,
    requestedProfile: "local-exec" as const,
    expectedArtifacts: [],
    behaviorChecks: [],
  };
}
