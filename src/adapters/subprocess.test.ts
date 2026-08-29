import {execPath} from "node:process";
import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {chmod, copyFile, mkdtemp, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {describe, expect, it} from "vitest";
import {runSubprocessAdapter} from "./subprocess.js";

describe.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))("subprocess adapter seam", () => {
  it("round-trips one bounded versioned JSON request through a real process", async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);process.stderr.write('adapter diagnostic token=secret-value');process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:r.requestId,state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:[]}));});";
    const result = await runSubprocessAdapter(
      {
        schemaVersion: "smokinggun.adapter-manifest.v1",
        id: "fixture",
        version: "1.0.0",
        command: [execPath, "-e", script],
        capabilities: [],
        limits: {timeoutMs: 2000, maxOutputBytes: 10000, maxArtifactBytes: 10000},
      },
      {schemaVersion: "smokinggun.adapter-request.v1", requestId: "req-1", root: ".", config: {}},
      {root: process.cwd()},
    );
    expect("_tag" in result).toBe(false);
    if (!("_tag" in result)) {
      expect(result.state).toBe("complete");
      expect(result.diagnostics[0]).toMatchObject({code: "adapter-stderr"});
      expect(result.diagnostics[0]?.detail).not.toContain("secret-value");
    }
  });

  it("accepts every declared adapter result state and preserves the state", async () => {
    for (const state of ["complete", "partial", "unavailable", "blocked", "failed", "cancelled"] as const) {
      const diagnostics =
        state === "complete"
          ? "[]"
          : "[{schemaVersion:'smokinggun.problem.v1',code:'fixture',message:'Fixture adapter state.'}]";
      const script = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:'req-1',state:'${state}',findings:[],coverage:[],diagnostics:${diagnostics},rawArtifacts:[]})));`;
      const result = await runSubprocessAdapter(manifest([execPath, "-e", script]), request(), {root: process.cwd()});
      expect("_tag" in result).toBe(false);
      if (!("_tag" in result)) expect(result.state).toBe(state);
    }
  });

  it("accepts artifact-free AdapterResultV2 and normalizes it to V3", async () => {
    const script =
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v2',requestId:'req-1',state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:[],rawArtifactDigests:{}})));";
    const result = await runSubprocessAdapter(manifest([execPath, "-e", script]), request(), {root: process.cwd()});
    expect("code" in result).toBe(false);
    if (!("code" in result)) expect(result.schemaVersion).toBe("smokinggun.adapter-result.v3");
  });

  it("returns bounded typed failures for malformed JSON, output overflow, and timeout", async () => {
    const malformed = await runSubprocessAdapter(
      manifest([execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('not-json'))"]),
      request(),
      {root: process.cwd()},
    );
    expect("code" in malformed).toBe(false);
    if (!("code" in malformed)) expect(malformed.state).toBe("failed");
    const overflow = await runSubprocessAdapter(
      manifest(
        [execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(1000)))"],
        2_000,
        100,
      ),
      request(),
      {root: process.cwd()},
    );
    expect("code" in overflow).toBe(false);
    if (!("code" in overflow)) expect(overflow.state).toBe("failed");
    const timeout = await runSubprocessAdapter(
      manifest([execPath, "-e", "process.stdin.resume();setTimeout(()=>{},1000)"], 30),
      request(),
      {root: process.cwd()},
    );
    expect("code" in timeout).toBe(false);
    if (!("code" in timeout)) expect(timeout.state).toBe("failed");
  });

  it("binds findings and coverage to the host-owned producer and requested targets", async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:r.requestId,state:'complete',findings:[{schemaVersion:'smokinggun.finding.v2',id:'sg_0123456789abcdef',scanner:'smokinggun.structural',scannerVersion:'99.0.0',ruleId:'fixture',severity:'low',confidence:'unknown',status:'unvalidated',relatedFindings:[],message:'fixture',suggestion:'inspect',location:{path:'allowed.ts',startLine:1,startColumn:0,endLine:1,endColumn:1},assumptions:[],evidence:[],complexity:{}}],coverage:[{scanner:'smokinggun.structural',version:'99.0.0',language:'mixed',filesDiscovered:999,filesAnalyzed:999,parseStatus:'complete',skippedFiles:[]}],analyzedTargets:r.targets,diagnostics:[],rawArtifacts:[]}));});";
    const result = await runSubprocessAdapter(
      manifest([execPath, "-e", script]),
      {...request(), targets: ["allowed.ts"]},
      {root: process.cwd()},
    );
    expect("code" in result).toBe(false);
    if (!("code" in result)) {
      expect(result.findings[0]).toMatchObject({
        scanner: "smokinggun.adapter:fixture",
        scannerVersion: "1.0.0",
        thirdParty: {adapterClaimedScanner: "smokinggun.structural", adapterClaimedScannerVersion: "99.0.0"},
      });
      expect(result.findings[0]?.id).not.toBe("sg_0123456789abcdef");
      expect(result.coverage).toEqual([
        expect.objectContaining({
          scanner: "smokinggun.adapter:fixture",
          version: "1.0.0",
          filesDiscovered: 1,
          filesAnalyzed: 1,
          parseStatus: "complete",
          skippedFiles: [],
        }),
      ]);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("rejects complete coverage without exact per-target receipts", async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:r.requestId,state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:[]}));});";
    const result = await runSubprocessAdapter(
      manifest([execPath, "-e", script]),
      {...request(), targets: ["allowed.ts"]},
      {root: process.cwd()},
    );
    expect(result).toMatchObject({code: "adapter-complete-receipts-missing"});
  });

  it("rejects findings outside the exact requested target set", async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:r.requestId,state:'complete',findings:[{schemaVersion:'smokinggun.finding.v2',id:'sg_0123456789abcdef',scanner:'fixture',scannerVersion:'1.0.0',ruleId:'fixture',severity:'low',confidence:'unknown',status:'unvalidated',relatedFindings:[],message:'fixture',suggestion:'inspect',location:{path:'excluded.ts',startLine:1,startColumn:0,endLine:1,endColumn:1},assumptions:[],evidence:[],complexity:{}}],coverage:[],diagnostics:[],rawArtifacts:[]}));});";
    const result = await runSubprocessAdapter(
      manifest([execPath, "-e", script]),
      {...request(), targets: ["allowed.ts"]},
      {root: process.cwd()},
    );
    expect(result).toMatchObject({code: "finding-scope-violation"});
  });

  it("enforces a read-only repository and an empty network namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-sandbox-"));
    try {
      const script =
        "const fs=require('node:fs');const net=require('node:net');let writeBlocked=false;try{fs.writeFileSync('forbidden.txt','x')}catch{writeBlocked=true}const socket=net.createConnection({host:'1.1.1.1',port:80});socket.on('error',()=>finish(true));socket.on('connect',()=>finish(false));setTimeout(()=>finish(false),500);let done=false;function finish(networkBlocked){if(done)return;done=true;socket.destroy();process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:'req-1',state:'complete',findings:[],coverage:[],diagnostics:[{schemaVersion:'smokinggun.problem.v1',code:'sandbox-observation',message:`write=${writeBlocked};network=${networkBlocked}`}],rawArtifacts:[]}));}";
      const result = await runSubprocessAdapter(manifest([execPath, "-e", script]), request(), {root});
      expect("code" in result).toBe(false);
      if (!("code" in result))
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({code: "sandbox-observation", message: "write=true;network=true"}),
        );
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("mounts an adapter executable installed outside the system runtime paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-root-"));
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "smokinggun-adapter-runtime-"));
    const runtime = join(runtimeDirectory, "node");
    try {
      await copyFile(execPath, runtime);
      await chmod(runtime, 0o755);
      const modulePath = join(runtimeDirectory, "adapter.cjs");
      await writeFile(
        modulePath,
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:'req-1',state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:[]})));",
        "utf8",
      );
      const result = await runSubprocessAdapter(manifest([runtime, modulePath]), request(), {
        root,
        runtimeRoots: [runtimeDirectory],
      });
      expect("code" in result).toBe(false);
      if (!("code" in result)) expect(result.state).toBe("complete");
    } finally {
      await rm(root, {recursive: true, force: true});
      await rm(runtimeDirectory, {recursive: true, force: true});
    }
  });

  it("retains adapter artifacts as exact content-addressed bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-adapter-artifact-"));
    try {
      const digest = createHash("sha256").update("evidence").digest("hex");
      const script = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:'req-1',state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:['evidence.json'],rawArtifactDigests:{'evidence.json':'${digest}'},rawArtifactContents:{'evidence.json':'${Buffer.from("evidence").toString("base64")}'}})));`;
      const result = await runSubprocessAdapter(manifest([execPath, "-e", script]), request(), {
        root,
        retainArtifact: async (_path, bytes) => ({
          reference: `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}`,
          digest: createHash("sha256").update(bytes).digest("hex"),
        }),
      });
      expect("code" in result).toBe(false);
      if (!("code" in result)) {
        expect(result.rawArtifacts).toEqual([`artifact://sha256/${digest}`]);
        expect(result.rawArtifactDigests).toEqual({[`artifact://sha256/${digest}`]: digest});
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("enforces the manifest artifact limit across all inline artifacts", async () => {
    const first = Buffer.from("first").toString("base64");
    const second = Buffer.from("second").toString("base64");
    const firstDigest = createHash("sha256").update("first").digest("hex");
    const secondDigest = createHash("sha256").update("second").digest("hex");
    const script = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:'req-1',state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:['first.txt','second.txt'],rawArtifactDigests:{'first.txt':'${firstDigest}','second.txt':'${secondDigest}'},rawArtifactContents:{'first.txt':'${first}','second.txt':'${second}'}})));`;
    const limitedManifest = manifest([execPath, "-e", script]);
    const retained: string[] = [];
    const result = await runSubprocessAdapter(
      {...limitedManifest, limits: {...limitedManifest.limits, maxArtifactBytes: 8}},
      request(),
      {
        root: process.cwd(),
        retainArtifact: async (path, bytes) => {
          retained.push(path);
          return {reference: path, digest: createHash("sha256").update(bytes).digest("hex")};
        },
      },
    );
    expect(result).toMatchObject({code: "artifact-too-large"});
    expect(retained).toEqual([]);
  });

  it("preserves artifact validation errors before complete nonzero-exit failures", async () => {
    const script =
      "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({schemaVersion:'smokinggun.adapter-result.v3',requestId:'req-1',state:'complete',findings:[],coverage:[],diagnostics:[],rawArtifacts:['evidence.txt'],rawArtifactDigests:{'evidence.txt':'" +
      "0".repeat(64) +
      "'},rawArtifactContents:{'evidence.txt':'ZXZpZGVuY2U='}}));process.exitCode=1;});";
    const result = await runSubprocessAdapter(manifest([execPath, "-e", script]), request(), {
      root: process.cwd(),
      retainArtifact: async () => {
        throw new Error("invalid artifacts must not be retained");
      },
    });
    expect(result).toMatchObject({code: "artifact-digest-mismatch"});
  });

  function manifest(command: ReadonlyArray<string>, timeoutMs = 2_000, maxOutputBytes = 10_000) {
    return {
      schemaVersion: "smokinggun.adapter-manifest.v1" as const,
      id: "fixture",
      version: "1.0.0",
      command,
      capabilities: [],
      limits: {timeoutMs, maxOutputBytes, maxArtifactBytes: 10_000},
    };
  }

  function request() {
    return {schemaVersion: "smokinggun.adapter-request.v1" as const, requestId: "req-1", root: ".", config: {}};
  }
});
