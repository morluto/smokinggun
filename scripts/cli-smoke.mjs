import {spawn} from "node:child_process";
import {chmod, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const root = process.cwd();
const entry = "dist/bin/footgun.js";
const sandbox = await mkdtemp(join(tmpdir(), "footgun-cli-contract-"));

try {

const scan = await run([entry, "scan", "fixtures/corpus/typescript", "--format", "json"]);
const report = JSON.parse(scan.stdout);
if (scan.code !== 0 || report.schemaVersion !== "footgun.scan-report.v1" || scan.stderr.length !== 0 || /\u001b|Footgun scan:/.test(scan.stdout)) throw new Error("JSON scan stream contract failed");

const sarif = await run([entry, "scan", "fixtures/corpus/typescript", "--format", "sarif"]);
if (sarif.code !== 0 || JSON.parse(sarif.stdout).version !== "2.1.0" || sarif.stderr.length !== 0) throw new Error("SARIF stream contract failed");

const scanners = await run([entry, "scanners", "list", "--format", "json"]);
const scannerValue = JSON.parse(scanners.stdout);
if (scanners.code !== 0 || scannerValue.schemaVersion !== "footgun.scanners.v1" || !Array.isArray(scannerValue.scanners) || scanners.stderr.length !== 0) throw new Error("scanner registry stream contract failed");

const explanation = await run([entry, "explain", "membership-in-loop", "--format", "json"]);
const explanationValue = JSON.parse(explanation.stdout);
if (explanation.code !== 0 || explanationValue.schemaVersion !== "footgun.explanation.v1" || explanationValue.ruleId !== "membership-in-loop" || explanation.stderr.length !== 0) throw new Error("explain command contract failed");

const investigation = await run([entry, "investigate", "fixtures/corpus/typescript", "--format", "json", "--non-interactive"]);
const investigationValue = JSON.parse(investigation.stdout);
if (investigation.code !== 0 || investigationValue.schemaVersion !== "footgun.investigation-bundle.v1" || !["inventoried", "scanned", "context-resolved"].includes(investigationValue.state) || investigation.stderr.length !== 0) throw new Error("investigation lifecycle contract failed");

const scanArtifact = join(sandbox, "scan-report.json");
await writeFile(scanArtifact, scan.stdout, "utf8");
const renderedReport = await run([entry, "report", scanArtifact, "--format", "json"]);
const renderedValue = JSON.parse(renderedReport.stdout);
if (renderedReport.code !== 0 || renderedValue.schemaVersion !== "footgun.scan-report.v1" || renderedReport.stderr.length !== 0) throw new Error("report JSON contract failed");
const renderedMarkdown = await run([entry, "report", scanArtifact, "--format", "markdown"]);
if (renderedMarkdown.code !== 0 || !renderedMarkdown.stdout.startsWith("# Footgun scan") || renderedMarkdown.stderr.length !== 0) throw new Error("report Markdown contract failed");
const renderedSarif = await run([entry, "report", scanArtifact, "--format", "sarif"]);
if (renderedSarif.code !== 0 || JSON.parse(renderedSarif.stdout).version !== "2.1.0" || renderedSarif.stderr.length !== 0) throw new Error("report SARIF contract failed");

const baselineArtifact = join(sandbox, "baseline.json");
const candidateArtifact = join(sandbox, "candidate.json");
await writeFile(baselineArtifact, JSON.stringify(measurement("a", 10)), "utf8");
await writeFile(candidateArtifact, JSON.stringify(measurement("b", 8)), "utf8");
const comparison = await run([entry, "compare", baselineArtifact, candidateArtifact, "--format", "json"]);
const comparisonValue = JSON.parse(comparison.stdout);
if (comparison.code !== 0 || comparisonValue.schemaVersion !== "footgun.comparison.v1" || comparisonValue.promotion !== "eligible" || comparison.stderr.length !== 0) throw new Error("comparison JSON contract failed");
const comparisonSarif = await run([entry, "compare", baselineArtifact, candidateArtifact, "--format", "sarif"]);
if (comparisonSarif.code !== 0 || JSON.parse(comparisonSarif.stdout).version !== "2.1.0" || comparisonSarif.stderr.length !== 0) throw new Error("comparison SARIF stream contract failed");

const policy = await run([entry, "scan", "fixtures/corpus/typescript", "--format", "json", "--fail-on", "finding"]);
if (policy.code !== 4 || JSON.parse(policy.stdout).schemaVersion !== "footgun.scan-report.v1" || policy.stderr.length !== 0) throw new Error("fail-on exit contract failed");

const strictIncomplete = await run([entry, "scan", "fixtures/edge/malformed.ts", "--format", "json", "--strict"]);
if (strictIncomplete.code !== 3 || JSON.parse(strictIncomplete.stdout).schemaVersion !== "footgun.scan-report.v1" || strictIncomplete.stderr.length !== 0 || strictIncomplete.stdout.trim().split("\n").length === 0) throw new Error("strict incomplete machine stream contract failed");

const selectedScanner = await run([entry, "scan", "fixtures/corpus/typescript", "--scanner", "typescript", "--format", "json", "--strict"]);
const selectedValue = JSON.parse(selectedScanner.stdout);
if (selectedScanner.code !== 3 || selectedValue.coverage[0]?.parseStatus !== "unavailable" || selectedScanner.stderr.length !== 0) throw new Error("explicit scanner selection coverage contract failed");

let rawTrace = false;
if (process.platform !== "win32") {
  const sandbox = await mkdtemp(join(tmpdir(), "footgun-cli-trace-"));
  const trace = join(sandbox, "fixture.pftrace");
  const processor = join(sandbox, "trace_processor");
  try {
    await writeFile(trace, "not-a-json-trace", "utf8");
    await writeFile(processor, "#!/usr/bin/env node\nprocess.stdout.write('name,dur\\nmain,12.5\\n');\n", "utf8");
    await chmod(processor, 0o755);
    const traceResult = await run([entry, "report", trace, "--profile", "perfetto", "--format", "json"], {FOOTGUN_TRACE_PROCESSOR: processor});
    const traceValue = JSON.parse(traceResult.stdout);
    if (traceResult.code !== 0 || traceValue.schemaVersion !== "footgun.trace-summary.v1" || traceValue.rows[0]?.name !== "main") throw new Error("raw Perfetto trace report contract failed");
    rawTrace = true;
  } finally {
    await rm(sandbox, {recursive: true, force: true});
  }
}

const action = await run([entry, "measure", "inv_smoke", "--format", "json"]);
const actionValue = JSON.parse(action.stdout);
if (action.code !== 2 || actionValue.schemaVersion !== "footgun.action-required.v1" || action.stderr.length !== 0) throw new Error("action-required exit contract failed");

const missingContext = await run([entry, "context", "import", join(sandbox, "missing.scip"), "--format", "json", "--non-interactive"]);
const missingContextValue = JSON.parse(missingContext.stdout);
if (missingContext.code !== 3 || missingContextValue.schemaVersion !== "footgun.context-import.v1" || missingContextValue.state !== "unavailable" || missingContext.stderr.length !== 0) throw new Error("SCIP unavailable contract failed");

const skillHome = join(sandbox, "codex-home");
const skill = await run([entry, "skill", "install", "--dry-run", "--format", "json"], {CODEX_HOME: skillHome});
const skillValue = JSON.parse(skill.stdout);
if (skill.code !== 0 || skillValue.schemaVersion !== "footgun.skill-install.v1" || skillValue.dryRun !== true || skill.stderr.length !== 0) throw new Error("skill dry-run contract failed");

console.log(JSON.stringify({scanFindings: report.findings.length, scanCoverage: report.coverage.length, scannerCount: scannerValue.scanners.length, investigationState: investigationValue.state, actionExit: action.code, policyExit: policy.code, strictIncompleteExit: strictIncomplete.code, rawTrace}));
} finally {
  await rm(sandbox, {recursive: true, force: true});
}

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {cwd: root, env: {...process.env, ...extraEnv, FOOTGUN_DATA_DIR: `${root}/.cli-smoke-data`}, shell: false});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({code: code ?? (signal === null ? 1 : 130), stdout, stderr}));
  });
}

function measurement(id, medianMs) {
  return {
    schemaVersion: "footgun.measurement.v1",
    id: `meas_${id.repeat(16)}`,
    workloadDigest: "a".repeat(64),
    samplesMs: [medianMs],
    warmups: 0,
    repetitions: 1,
    medianMs,
    meanMs: medianMs,
    quartiles: {q1Ms: medianMs, q3Ms: medianMs},
    statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
    reproduction: {command: ["node", "fixture.js"], cwd: ".", environmentKeys: [], timeoutMs: 1000, warmups: 0, repetitions: 1, expectedArtifacts: [], datasetDigests: {}},
    behaviorValidated: true,
    executionProfile: "container-exec",
    environment: {node: process.versions.node, platform: process.platform, arch: process.arch},
    isolation: {backend: "bwrap", controlsRequested: ["network-none"], controlsApplied: ["network-none"], downgradeReasons: []},
  };
}
