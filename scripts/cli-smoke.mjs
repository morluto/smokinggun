import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {create, toBinary} from "@bufbuild/protobuf";
import {IndexSchema, ProtocolVersion, SymbolInformation_Kind, SymbolRole, TextEncoding} from "@scip-code/scip";

const root = process.cwd();
const entry = "dist/bin/smokinggun.js";
const sandbox = await mkdtemp(join(tmpdir(), "smokinggun-cli-contract-"));

try {
  const scan = await run([entry, "scan", "fixtures/corpus/typescript", "--format", "json"]);
  const report = JSON.parse(scan.stdout);
  if (
    scan.code !== 0 ||
    report.schemaVersion !== "smokinggun.scan-report.v2" ||
    scan.stderr.length !== 0 ||
    scan.stdout.includes("\u001b") ||
    scan.stdout.includes("SmokingGun scan:")
  )
    throw new Error("JSON scan stream contract failed");

  const sarif = await run([entry, "scan", "fixtures/corpus/typescript", "--format", "sarif"]);
  if (sarif.code !== 0 || JSON.parse(sarif.stdout).version !== "2.1.0" || sarif.stderr.length !== 0)
    throw new Error("SARIF stream contract failed");

  const scanners = await run([entry, "scanners", "list", "--format", "json"]);
  const scannerValue = JSON.parse(scanners.stdout);
  if (
    scanners.code !== 0 ||
    scannerValue.schemaVersion !== "smokinggun.scanners.v1" ||
    !Array.isArray(scannerValue.scanners) ||
    scanners.stderr.length !== 0
  )
    throw new Error("scanner registry stream contract failed");

  const doctor = await run([entry, "doctor", "--format", "json"]);
  const doctorValue = JSON.parse(doctor.stdout);
  const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  if (doctor.code !== 0 || doctorValue.version !== packageVersion || doctor.stderr.length !== 0)
    throw new Error("doctor must report the package-derived tool identity");

  const explanation = await run([entry, "explain", "membership-in-loop", "--format", "json"]);
  const explanationValue = JSON.parse(explanation.stdout);
  if (
    explanation.code !== 0 ||
    explanationValue.schemaVersion !== "smokinggun.explanation.v1" ||
    explanationValue.ruleId !== "membership-in-loop" ||
    explanation.stderr.length !== 0
  )
    throw new Error("explain command contract failed");
  const stableExplanation = await run([entry, "explain", "sg_0123456789abcdef", "--format", "json"]);
  const stableExplanationValue = JSON.parse(stableExplanation.stdout);
  if (
    stableExplanation.code !== 2 ||
    stableExplanationValue.code !== "finding-report-required" ||
    !stableExplanationValue.recovery.includes("REPORT.json") ||
    stableExplanation.stderr.length !== 0
  )
    throw new Error("stable finding IDs must require their source report");

  const investigation = await run([
    entry,
    "investigate",
    "fixtures/corpus/typescript",
    "--format",
    "json",
    "--non-interactive",
  ]);
  const investigationValue = JSON.parse(investigation.stdout);
  if (
    investigation.code !== 0 ||
    investigationValue.schemaVersion !== "smokinggun.investigation-bundle.v2" ||
    !["inventoried", "scanned", "context-resolved"].includes(investigationValue.state) ||
    investigation.stderr.length !== 0
  )
    throw new Error("investigation lifecycle contract failed");
  const scanEvidence = investigationValue.evidence.find(
    (evidence) => evidence.kind === "static" && evidence.artifact.startsWith("artifact://sha256/"),
  );
  const storedScan = await readFile(artifactPath(scanEvidence?.artifact));
  const storedScanDigest = createHash("sha256").update(storedScan).digest("hex");
  if (scanEvidence?.digest !== storedScanDigest)
    throw new Error("investigation scan evidence digest must match its stored artifact");
  const repeatedInvestigation = await run([
    entry,
    "investigate",
    "fixtures/corpus/typescript",
    "--format",
    "json",
    "--non-interactive",
  ]);
  const repeatedInvestigationValue = JSON.parse(repeatedInvestigation.stdout);
  if (
    repeatedInvestigation.code !== 0 ||
    repeatedInvestigationValue.id !== investigationValue.id ||
    repeatedInvestigationValue.state !== investigationValue.state ||
    repeatedInvestigation.stderr.length !== 0
  )
    throw new Error("investigate must reuse the stable source/configuration investigation identity");

  const scipArtifact = join(sandbox, "context.scip");
  await writeFile(
    scipArtifact,
    toBinary(
      IndexSchema,
      create(IndexSchema, {
        metadata: {
          version: ProtocolVersion.UnspecifiedProtocolVersion,
          toolInfo: {name: "fixture-indexer", version: "1.0.0"},
          projectRoot: root,
          textDocumentEncoding: TextEncoding.UTF8,
        },
        documents: [
          {
            language: "TypeScript",
            relativePath: "fixtures/corpus/typescript/nested-scan.ts",
            symbols: [{symbol: "local 0", displayName: "collect", kind: SymbolInformation_Kind.Function}],
            occurrences: [{range: [0, 0, 7], symbol: "local 0", symbolRoles: SymbolRole.Definition}],
          },
        ],
      }),
    ),
  );
  const importedContext = await run([
    entry,
    "context",
    "import",
    scipArtifact,
    "--investigation",
    investigationValue.id,
    "--format",
    "json",
  ]);
  const importedContextValue = JSON.parse(importedContext.stdout);
  if (
    importedContext.code !== 0 ||
    importedContextValue.schemaVersion !== "smokinggun.context-import.v1" ||
    importedContextValue.state === "unavailable" ||
    importedContext.stderr.length !== 0
  )
    throw new Error("SCIP context-import contract failed");
  const contextPointer = JSON.parse(
    await readFile(join(sandbox, "data", "investigations", investigationValue.id, "latest.json"), "utf8"),
  );
  const contextBundle = JSON.parse(
    await readFile(
      join(
        sandbox,
        "data",
        "investigations",
        investigationValue.id,
        "snapshots",
        `${contextPointer.bundleDigest}.json`,
      ),
      "utf8",
    ),
  );
  const contextEvidence = contextBundle.bundle.evidence.find((evidence) => evidence.kind === "context");
  if (contextEvidence === undefined) throw new Error("context import must append investigation evidence");
  const storedContext = await readFile(artifactPath(contextEvidence.artifact));
  if (contextEvidence.digest !== createHash("sha256").update(storedContext).digest("hex"))
    throw new Error("context evidence digest must match its stored artifact");

  const firstPlan = await run([
    entry,
    "investigate",
    "fixtures/corpus/typescript",
    "--plan-only",
    "--format",
    "json",
    "--non-interactive",
  ]);
  const secondPlan = await run([
    entry,
    "investigate",
    "fixtures/corpus/typescript",
    "--plan-only",
    "--format",
    "json",
    "--non-interactive",
  ]);
  const firstPlanValue = JSON.parse(firstPlan.stdout);
  const secondPlanValue = JSON.parse(secondPlan.stdout);
  if (
    firstPlan.code !== 0 ||
    secondPlan.code !== 0 ||
    firstPlanValue.id !== secondPlanValue.id ||
    firstPlanValue.state !== "measurement-planned" ||
    secondPlanValue.state !== "measurement-planned"
  )
    throw new Error("plan-only investigations must be repeatable");

  const missingFinding = await run([
    entry,
    "investigate",
    "fixtures/corpus/typescript",
    "--finding",
    "sg_0000000000000000",
    "--format",
    "json",
    "--non-interactive",
  ]);
  const missingFindingValue = JSON.parse(missingFinding.stdout);
  if (
    missingFinding.code !== 2 ||
    missingFindingValue.schemaVersion !== "smokinggun.problem.v1" ||
    missingFindingValue.code !== "finding-not-found" ||
    missingFinding.stderr.length !== 0
  )
    throw new Error("investigate must reject finding IDs absent from its scan report");

  const scanArtifact = join(sandbox, "scan-report.json");
  await writeFile(scanArtifact, scan.stdout, "utf8");
  const invalidArtifact = join(root, "package.json");
  const invalidArtifactDigest = createHash("sha256")
    .update(await readFile(invalidArtifact))
    .digest("hex");
  const invalidReport = await run([entry, "report", invalidArtifact, "--format", "json"]);
  const invalidReportValue = JSON.parse(invalidReport.stdout);
  const invalidArtifactStored = await access(join(sandbox, "data", "artifacts", "sha256", invalidArtifactDigest)).then(
    () => true,
    () => false,
  );
  if (
    invalidReport.code !== 2 ||
    invalidReportValue.schemaVersion !== "smokinggun.problem.v1" ||
    invalidArtifactStored ||
    invalidReport.stderr.length !== 0
  )
    throw new Error("invalid report input must be rejected before artifact storage");
  const renderedReport = await run([entry, "report", scanArtifact, "--format", "json"]);
  const renderedValue = JSON.parse(renderedReport.stdout);
  if (
    renderedReport.code !== 0 ||
    renderedValue.schemaVersion !== "smokinggun.scan-report.v2" ||
    renderedReport.stderr.length !== 0
  )
    throw new Error("report JSON contract failed");
  const renderedMarkdown = await run([entry, "report", scanArtifact, "--format", "markdown"]);
  if (
    renderedMarkdown.code !== 0 ||
    !renderedMarkdown.stdout.startsWith("# SmokingGun scan") ||
    renderedMarkdown.stderr.length !== 0
  )
    throw new Error("report Markdown contract failed");
  const renderedSarif = await run([entry, "report", scanArtifact, "--format", "sarif"]);
  if (
    renderedSarif.code !== 0 ||
    JSON.parse(renderedSarif.stdout).version !== "2.1.0" ||
    renderedSarif.stderr.length !== 0
  )
    throw new Error("report SARIF contract failed");

  const invalidReportInvestigation = await run([
    entry,
    "report",
    scanArtifact,
    "--investigation",
    "not-an-id",
    "--format",
    "json",
  ]);
  const invalidReportInvestigationValue = JSON.parse(invalidReportInvestigation.stdout);
  if (
    invalidReportInvestigation.code !== 2 ||
    invalidReportInvestigationValue.schemaVersion !== "smokinggun.problem.v1" ||
    invalidReportInvestigationValue.code !== "investigation-unavailable" ||
    invalidReportInvestigation.stderr.length !== 0
  )
    throw new Error("report must validate an investigation before emitting its artifact");

  const baselineArtifact = join(sandbox, "baseline.json");
  const candidateArtifact = join(sandbox, "candidate.json");
  await writeFile(baselineArtifact, JSON.stringify(measurement("a", 10)), "utf8");
  await writeFile(candidateArtifact, JSON.stringify(measurement("b", 8)), "utf8");
  const comparison = await run([entry, "compare", baselineArtifact, candidateArtifact, "--format", "json"]);
  const comparisonValue = JSON.parse(comparison.stdout);
  if (
    comparison.code !== 0 ||
    comparisonValue.schemaVersion !== "smokinggun.comparison.v2" ||
    comparisonValue.promotion !== "eligible" ||
    comparisonValue.promotionReasons.length !== 0 ||
    comparison.stderr.length !== 0
  )
    throw new Error("comparison JSON contract failed");
  const comparisonSarif = await run([entry, "compare", baselineArtifact, candidateArtifact, "--format", "sarif"]);
  if (
    comparisonSarif.code !== 0 ||
    JSON.parse(comparisonSarif.stdout).version !== "2.1.0" ||
    comparisonSarif.stderr.length !== 0
  )
    throw new Error("comparison SARIF stream contract failed");

  const retryInvestigationId = "inv_0123456789abcdef";
  const retryInvestigationDirectory = join(sandbox, "data", "investigations", retryInvestigationId);
  await mkdir(retryInvestigationDirectory, {recursive: true});
  await writeFile(
    join(retryInvestigationDirectory, "bundle.json"),
    JSON.stringify({
      schemaVersion: "smokinggun.investigation-bundle.v2",
      id: retryInvestigationId,
      state: "baseline-measured",
      root: ".",
      createdAt: new Date().toISOString(),
      reports: ["../measurements/seed.json"],
      evidence: [
        {
          schemaVersion: "smokinggun.evidence.v2",
          id: `${retryInvestigationId}:measurement:seed`,
          kind: "measurement",
          claimClass: "constant-factor",
          summary: "Seed measurement",
          artifact: "../measurements/seed.json",
        },
      ],
      diagnostics: [],
    }),
    "utf8",
  );
  const retryBaselineArtifact = join(sandbox, "retry-baseline.json");
  const retryCandidateArtifact = join(sandbox, "retry-candidate.json");
  await writeFile(
    retryBaselineArtifact,
    JSON.stringify({...measurement("c", 10), investigation: retryInvestigationId}),
    "utf8",
  );
  await writeFile(
    retryCandidateArtifact,
    JSON.stringify({...measurement("d", 8), investigation: retryInvestigationId}),
    "utf8",
  );
  const retainedInvestigation = JSON.parse(await readFile(join(retryInvestigationDirectory, "bundle.json"), "utf8"));
  retainedInvestigation.reports = ["retry-baseline.json", "retry-candidate.json"];
  retainedInvestigation.evidence = [
    {
      schemaVersion: "smokinggun.evidence.v2",
      id: `${retryInvestigationId}:measurement:baseline`,
      kind: "measurement",
      claimClass: "constant-factor",
      summary: "Retained baseline measurement",
      artifact: "retry-baseline.json",
      digest: createHash("sha256")
        .update(await readFile(retryBaselineArtifact))
        .digest("hex"),
    },
    {
      schemaVersion: "smokinggun.evidence.v2",
      id: `${retryInvestigationId}:measurement:candidate`,
      kind: "measurement",
      claimClass: "constant-factor",
      summary: "Retained candidate measurement",
      artifact: "retry-candidate.json",
      digest: createHash("sha256")
        .update(await readFile(retryCandidateArtifact))
        .digest("hex"),
    },
  ];
  await writeFile(join(retryInvestigationDirectory, "bundle.json"), JSON.stringify(retainedInvestigation), "utf8");
  const initialComparison = await run([
    entry,
    "compare",
    retryBaselineArtifact,
    retryCandidateArtifact,
    "--format",
    "json",
  ]);
  if (initialComparison.code !== 0)
    throw new Error(`initial investigation comparison failed: ${initialComparison.stdout}${initialComparison.stderr}`);
  const pointerAfterInitialComparison = await readFile(join(retryInvestigationDirectory, "latest.json"), "utf8");
  const retriedComparison = await run([
    entry,
    "compare",
    retryBaselineArtifact,
    retryCandidateArtifact,
    "--format",
    "json",
  ]);
  const pointerAfterRetriedComparison = await readFile(join(retryInvestigationDirectory, "latest.json"), "utf8");
  if (
    initialComparison.code !== 0 ||
    retriedComparison.code !== 0 ||
    JSON.parse(retriedComparison.stdout).schemaVersion !== "smokinggun.comparison.v2" ||
    initialComparison.stderr.length !== 0 ||
    retriedComparison.stderr.length !== 0 ||
    pointerAfterInitialComparison !== pointerAfterRetriedComparison
  )
    throw new Error("a completed comparison must be retry-safe without changing its investigation snapshot");

  const policy = await run([entry, "scan", "fixtures/corpus/typescript", "--format", "json", "--fail-on", "finding"]);
  if (
    policy.code !== 4 ||
    JSON.parse(policy.stdout).schemaVersion !== "smokinggun.scan-report.v2" ||
    policy.stderr.length !== 0
  )
    throw new Error("fail-on exit contract failed");

  const strictIncomplete = await run([entry, "scan", "fixtures/edge/malformed.ts", "--format", "json", "--strict"]);
  if (
    strictIncomplete.code !== 3 ||
    JSON.parse(strictIncomplete.stdout).schemaVersion !== "smokinggun.scan-report.v2" ||
    strictIncomplete.stderr.length !== 0 ||
    strictIncomplete.stdout.trim().split("\n").length === 0
  )
    throw new Error("strict incomplete machine stream contract failed");

  const selectedScanner = await run([
    entry,
    "scan",
    "fixtures/corpus/typescript",
    "--scanner",
    "typescript",
    "--format",
    "json",
    "--strict",
  ]);
  const selectedValue = JSON.parse(selectedScanner.stdout);
  if (
    selectedScanner.code !== 3 ||
    !selectedValue.coverage.some(
      (coverage) => coverage.scanner === "smokinggun.typescript-semantic" && coverage.parseStatus === "partial",
    ) ||
    selectedValue.coverage.some((coverage) => coverage.scanner === "smokinggun.structural") ||
    selectedScanner.stderr.length !== 0
  )
    throw new Error("explicit scanner selection coverage contract failed");

  const canonicalPython = await run([
    entry,
    "scan",
    "fixtures/corpus/python",
    "--scanner",
    "smokinggun.python-semantic",
    "--format",
    "json",
    "--strict",
  ]);
  const canonicalPythonValue = JSON.parse(canonicalPython.stdout);
  if (
    canonicalPython.code !== 0 ||
    !canonicalPythonValue.findings.some((finding) => finding.scanner === "smokinggun.python-semantic") ||
    !canonicalPythonValue.coverage.some(
      (coverage) => coverage.scanner === "smokinggun.python-semantic" && coverage.parseStatus === "complete",
    ) ||
    canonicalPython.stderr.length !== 0
  )
    throw new Error("advertised canonical scanner IDs must be selectable");

  const unknownScanner = await run([
    entry,
    "scan",
    "fixtures/corpus/python",
    "--scanner",
    "definitely-not-a-scanner",
    "--format",
    "json",
  ]);
  const unknownScannerValue = JSON.parse(unknownScanner.stdout);
  if (
    unknownScanner.code !== 2 ||
    unknownScannerValue.code !== "invalid-scanner-selection" ||
    unknownScanner.stderr.length !== 0
  )
    throw new Error("unknown scanner IDs must fail before traversal");

  const unmatchedScope = await run([
    entry,
    "scan",
    "fixtures/corpus",
    "--only",
    "missing",
    "--format",
    "json",
    "--strict",
  ]);
  const unmatchedScopeValue = JSON.parse(unmatchedScope.stdout);
  if (
    unmatchedScope.code !== 3 ||
    !unmatchedScopeValue.diagnostics.some((diagnostic) => diagnostic.code === "scan-scope-unmatched") ||
    unmatchedScope.stderr.length !== 0
  )
    throw new Error("unmatched explicit scope must remain incomplete under strict mode");

  const unmatchedPythonScope = await run([
    entry,
    "scan",
    "fixtures/corpus",
    "--only",
    "missing",
    "--scanner",
    "smokinggun.python-semantic",
    "--format",
    "json",
    "--strict",
  ]);
  if (unmatchedPythonScope.code !== 3 || JSON.parse(unmatchedPythonScope.stdout).diagnostics.length === 0)
    throw new Error("unmatched explicit scope must remain incomplete for selected Python scanning");

  const adapterProbeMarker = join(sandbox, "adapter-probe-marker");
  await writeFile(join(sandbox, "fixture.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(sandbox, "smokinggun.config.json"), JSON.stringify({adapters: ["adapter.json"]}), "utf8");
  await writeFile(
    join(sandbox, "adapter.json"),
    JSON.stringify({
      schemaVersion: "smokinggun.adapter-manifest.v1",
      id: "untrusted-adapter",
      version: "1.0.0",
      command: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(adapterProbeMarker)}, 'executed')`,
      ],
      capabilities: ["static-scan"],
      limits: {timeoutMs: 1000, maxOutputBytes: 1000, maxArtifactBytes: 1000},
    }),
    "utf8",
  );
  const untrustedAdapter = await run([entry, "scan", ".", "--cwd", sandbox, "--format", "json"]);
  const untrustedAdapterValue = JSON.parse(untrustedAdapter.stdout);
  const adapterProbeRan = await access(adapterProbeMarker).then(
    () => true,
    () => false,
  );
  if (
    untrustedAdapter.code !== 0 ||
    adapterProbeRan ||
    !untrustedAdapterValue.diagnostics.some((diagnostic) => diagnostic.code === "adapter-execution-required")
  )
    throw new Error("repository-configured adapters must not execute during static scans");

  await writeFile(join(sandbox, "smokinggun.config.json"), "{}", "utf8");
  const rejectedAuthorizedSelection = await run([
    entry,
    "scan",
    join(root, "fixtures", "corpus", "python"),
    "--cwd",
    sandbox,
    "--adapter",
    "adapter.json",
    "--scanner",
    "definitely-not-a-scanner",
    "--allow-adapter-execution",
    "--format",
    "json",
  ]);
  const adapterExecutedBeforeSelectionFailure = await access(adapterProbeMarker).then(
    () => true,
    () => false,
  );
  if (
    rejectedAuthorizedSelection.code !== 2 ||
    JSON.parse(rejectedAuthorizedSelection.stdout).code !== "invalid-scanner-selection" ||
    adapterExecutedBeforeSelectionFailure
  )
    throw new Error("invalid scanner selection must fail before authorized adapter probing");

  const adapterAgainstSeparateTarget = await run([
    entry,
    "scan",
    join(root, "fixtures", "corpus", "python"),
    "--cwd",
    sandbox,
    "--adapter",
    "adapter.json",
    "--scanner",
    "untrusted-adapter",
    "--allow-adapter-execution",
    "--format",
    "json",
  ]);
  const adapterAgainstSeparateTargetValue = JSON.parse(adapterAgainstSeparateTarget.stdout);
  const authorizedAdapterEscaped = await access(adapterProbeMarker).then(
    () => true,
    () => false,
  );
  if (
    adapterAgainstSeparateTarget.code !== 0 ||
    authorizedAdapterEscaped ||
    !adapterAgainstSeparateTargetValue.coverage.some(
      (coverage) =>
        coverage.scanner === "smokinggun.adapter:untrusted-adapter" && coverage.parseStatus === "unavailable",
    ) ||
    adapterAgainstSeparateTargetValue.diagnostics.some(
      (diagnostic) => diagnostic.code === "adapter-manifest-read-failed",
    )
  )
    throw new Error("adapter manifests must be resolved once while sandboxed execution remains confined");

  let rawTrace = false;
  if (process.platform !== "win32") {
    const sandbox = await mkdtemp(join(tmpdir(), "smokinggun-cli-trace-"));
    const trace = join(sandbox, "fixture.pftrace");
    const processor = join(sandbox, "trace_processor");
    try {
      await writeFile(trace, "not-a-json-trace", "utf8");
      await writeFile(
        processor,
        "#!/usr/bin/env node\nconst fs = require('node:fs');\nconst pinned = process.argv[3] !== process.env.SMOKINGGUN_TEST_ORIGINAL_TRACE && fs.readFileSync(process.argv[3], 'utf8') === 'not-a-json-trace';\nprocess.stdout.write(`name,dur,pinned\\nmain,12.5,${pinned}\\n`);\n",
        "utf8",
      );
      await chmod(processor, 0o755);
      const traceResult = await run([entry, "report", trace, "--profile", "perfetto", "--format", "json"], {
        SMOKINGGUN_TRACE_PROCESSOR: processor,
        SMOKINGGUN_TEST_ORIGINAL_TRACE: trace,
      });
      const traceValue = JSON.parse(traceResult.stdout);
      if (
        traceResult.code !== 0 ||
        traceValue.schemaVersion !== "smokinggun.trace-summary.v1" ||
        traceValue.rows[0]?.name !== "main" ||
        traceValue.rows[0]?.pinned !== "true"
      )
        throw new Error("raw Perfetto trace report contract failed");
      rawTrace = true;
    } finally {
      await rm(sandbox, {recursive: true, force: true});
    }
  }

  const unreadyInvestigationId = "inv_1111111111111111";
  const unreadyInvestigationDirectory = join(sandbox, "data", "investigations", unreadyInvestigationId);
  await mkdir(unreadyInvestigationDirectory, {recursive: true});
  await writeFile(
    join(unreadyInvestigationDirectory, "bundle.json"),
    JSON.stringify({
      schemaVersion: "smokinggun.investigation-bundle.v2",
      id: unreadyInvestigationId,
      state: "created",
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    }),
    "utf8",
  );
  const unreadyContext = await run([
    entry,
    "context",
    "import",
    scipArtifact,
    "--investigation",
    unreadyInvestigationId,
    "--format",
    "json",
  ]);
  const unreadyContextValue = JSON.parse(unreadyContext.stdout);
  const unreadyInvestigationFiles = await readdir(unreadyInvestigationDirectory);
  if (
    unreadyContext.code !== 1 ||
    unreadyContextValue.schemaVersion !== "smokinggun.problem.v1" ||
    unreadyContextValue.code !== "investigation-not-context-ready" ||
    unreadyInvestigationFiles.length !== 1 ||
    unreadyInvestigationFiles[0] !== "bundle.json"
  )
    throw new Error("an unready investigation must fail before persisting imported context");

  const missingContext = await run([
    entry,
    "context",
    "import",
    join(sandbox, "missing.scip"),
    "--format",
    "json",
    "--non-interactive",
  ]);
  const missingContextValue = JSON.parse(missingContext.stdout);
  if (
    missingContext.code !== 3 ||
    missingContextValue.schemaVersion !== "smokinggun.context-import.v1" ||
    missingContextValue.state !== "unavailable" ||
    missingContext.stderr.length !== 0
  )
    throw new Error("SCIP unavailable contract failed");

  console.log(
    JSON.stringify({
      scanFindings: report.findings.length,
      scanCoverage: report.coverage.length,
      scannerCount: scannerValue.scanners.length,
      investigationState: investigationValue.state,
      policyExit: policy.code,
      strictIncompleteExit: strictIncomplete.code,
      rawTrace,
    }),
  );
} finally {
  await rm(sandbox, {recursive: true, force: true});
}

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {...process.env, ...extraEnv, SMOKINGGUN_DATA_DIR: join(sandbox, "data")},
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({code: code ?? (signal === null ? 1 : 130), stdout, stderr}));
  });
}

function measurement(id, medianMs) {
  return {
    schemaVersion: "smokinggun.measurement.v1",
    id: `meas_${id.repeat(16)}`,
    benchmarkDigest: "a".repeat(64),
    samplesMs: [medianMs],
    warmups: 0,
    repetitions: 1,
    medianMs,
    meanMs: medianMs,
    quartiles: {q1Ms: medianMs, q3Ms: medianMs},
    statisticalPolicy: {kind: "median-improvement", minimumRelativeImprovement: 0},
    reproduction: {
      command: ["node", "fixture.js"],
      cwd: ".",
      environmentKeys: [],
      environmentDigest: "b".repeat(64),
      executable: {path: "[HOST_PATH]/node", digest: "c".repeat(64)},
      subjectDigest: id.repeat(64),
      inputSetDigest: "d".repeat(64),
      timeoutMs: 1000,
      warmups: 0,
      repetitions: 1,
      expectedArtifacts: [],
      artifactDigests: {},
      datasetDigests: {},
    },
    behaviorValidated: true,
    behaviorChecks: [{check: "exit-code:0", passed: true}],
    executionProfile: "external-benchmark",
    environment: {node: process.versions.node, platform: process.platform, arch: process.arch},
    isolation: {
      backend: "producer-declared",
      hostDigest: "f".repeat(64),
      runtime: {name: "fixture-runner", version: "1.0.0", digest: "e".repeat(64)},
      controlsRequested: ["network-none"],
      controlsApplied: ["network-none"],
      downgradeReasons: [],
    },
  };
}

function artifactPath(reference) {
  const digest = reference?.match(/^artifact:\/\/sha256\/([a-f0-9]{64})$/)?.[1];
  if (digest === undefined) throw new Error("expected a content-addressed artifact reference");
  return join(sandbox, "data", "artifacts", "sha256", digest);
}
