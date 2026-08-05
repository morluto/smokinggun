import {execPath} from "node:process";
import {describe, expect, it} from "vitest";
import {runSubprocessAdapter} from "./subprocess.js";

describe("subprocess adapter seam", () => {
  it("round-trips one bounded versioned JSON request through a real process", async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);process.stderr.write('adapter diagnostic token=secret-value');process.stdout.write(JSON.stringify({schemaVersion:'footgun.adapter-result.v1',requestId:r.requestId,state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:[]}));});";
    const result = await runSubprocessAdapter({schemaVersion: "footgun.adapter-manifest.v1", id: "fixture", version: "1.0.0", command: [execPath, "-e", script], capabilities: [], limits: {timeoutMs: 2000, maxOutputBytes: 10000, maxArtifactBytes: 10000}}, {schemaVersion: "footgun.adapter-request.v1", requestId: "req-1", root: ".", config: {}}, {root: process.cwd()});
    expect("_tag" in result).toBe(false);
    if (!("_tag" in result)) {
      expect(result.state).toBe("complete");
      expect(result.diagnostics[0]).toMatchObject({code: "adapter-stderr"});
      expect(result.diagnostics[0]?.detail).not.toContain("secret-value");
    }
  });

  it("accepts every declared adapter result state and preserves the state", async () => {
    for (const state of ["complete", "partial", "unavailable", "blocked", "failed", "cancelled"] as const) {
      const script = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({schemaVersion:'footgun.adapter-result.v1',requestId:'req-1',state:'${state}',findings:[],coverage:[],diagnostics:[],rawArtifacts:[]})));`;
      const result = await runSubprocessAdapter(manifest([execPath, "-e", script]), request(), {root: process.cwd()});
      expect("_tag" in result).toBe(false);
      if (!("_tag" in result)) expect(result.state).toBe(state);
    }
  });

  it("returns bounded typed failures for malformed JSON, output overflow, and timeout", async () => {
    const malformed = await runSubprocessAdapter(manifest([execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('not-json'))"]), request(), {root: process.cwd()});
    expect("code" in malformed).toBe(false);
    if (!("code" in malformed)) expect(malformed.state).toBe("failed");
    const overflow = await runSubprocessAdapter(manifest([execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(1000)))"], 2_000, 100), request(), {root: process.cwd()});
    expect("code" in overflow).toBe(false);
    if (!("code" in overflow)) expect(overflow.state).toBe("failed");
    const timeout = await runSubprocessAdapter(manifest([execPath, "-e", "process.stdin.resume();setTimeout(()=>{},1000)"], 30), request(), {root: process.cwd()});
    expect("code" in timeout).toBe(false);
    if (!("code" in timeout)) expect(timeout.state).toBe("failed");
  });

  function manifest(command: ReadonlyArray<string>, timeoutMs = 2_000, maxOutputBytes = 10_000) {
    return {schemaVersion: "footgun.adapter-manifest.v1" as const, id: "fixture", version: "1.0.0", command, capabilities: [], limits: {timeoutMs, maxOutputBytes, maxArtifactBytes: 10_000}};
  }

  function request() {
    return {schemaVersion: "footgun.adapter-request.v1" as const, requestId: "req-1", root: ".", config: {}};
  }
});
