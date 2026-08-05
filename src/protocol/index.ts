import {z} from "zod";

const version = <const T extends string>(value: T) => z.literal(value);

const locationSchema = z.strictObject({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().nonnegative(),
});

const problemSchema = z.strictObject({
  schemaVersion: version("footgun.problem.v1"),
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().optional(),
  path: z.string().optional(),
  recovery: z.string().optional(),
});

const actionRequiredSchema = z.strictObject({
  schemaVersion: version("footgun.action-required.v1"),
  reason: z.string().min(1),
  explanation: z.string().min(1),
  recoveryCommands: z.array(z.string()),
});

const coverageSchema = z.strictObject({
  scanner: z.string().min(1),
  version: z.string().min(1),
  language: z.string().min(1),
  filesDiscovered: z.number().int().nonnegative(),
  filesAnalyzed: z.number().int().nonnegative(),
  parseStatus: z.enum(["complete", "partial", "failed", "unavailable"]),
  skippedFiles: z.array(z.string()),
  reason: z.string().optional(),
});

const findingSchema = z.strictObject({
  schemaVersion: version("footgun.finding.v1"),
  id: z.string().regex(/^fg_[a-f0-9]{16}$/),
  scanner: z.string().min(1),
  scannerVersion: z.string().min(1),
  ruleId: z.string().min(1),
  language: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  claimClass: z.enum(["static-fact", "theoretical-estimate", "empirical-scaling", "constant-factor", "system-bottleneck", "behavioral", "unknown"]).optional(),
  severity: z.enum(["high", "medium", "low", "info"]),
  confidence: z.enum(["candidate", "type-informed", "verified", "unknown"]),
  status: z.enum(["unvalidated", "supported", "measured", "rejected", "blocked", "inconclusive"]).default("unvalidated"),
  relatedFindings: z.array(z.string().regex(/^fg_[a-f0-9]{16}$/)).default([]),
  message: z.string().min(1),
  suggestion: z.string().min(1),
  location: locationSchema,
  assumptions: z.array(z.string()),
  evidence: z.array(z.string()),
  evidenceRecords: z.array(z.strictObject({
    schemaVersion: version("footgun.evidence.v1"),
    id: z.string().min(1),
    kind: z.enum(["static", "estimate", "measurement", "benchmark", "profile", "trace", "behavior", "context", "unknown"]),
    summary: z.string().min(1),
    artifact: z.string().optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })).optional(),
  thirdParty: z.record(z.string(), z.unknown()).optional(),
  complexity: z.strictObject({
    current: z.string().optional(),
    expected: z.string().optional(),
  }),
});

const timingsSchema = z.strictObject({
  startedAt: z.string().datetime({offset: true}),
  durationMs: z.number().nonnegative(),
});

const repositorySchema = z.strictObject({
  root: z.string().min(1),
  revision: z.string().nullable(),
  dirty: z.boolean(),
});

const inventorySchema = z.strictObject({
  schemaVersion: version("footgun.repository-inventory.v1"),
  languages: z.array(z.strictObject({language: z.string().min(1), files: z.number().int().nonnegative(), extensions: z.array(z.string().min(1))})),
  manifests: z.array(z.string().min(1)),
  packageManagers: z.array(z.string().min(1)),
  tests: z.array(z.string().min(1)),
  benchmarks: z.array(z.string().min(1)),
  generated: z.array(z.string().min(1)),
  ignored: z.array(z.string().min(1)),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

const contextDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  type: z.string().optional(),
  alias: z.string().optional(),
});

const contextReferenceSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  resolved: z.boolean(),
  alias: z.string().optional(),
});

const contextCallSchema = z.strictObject({
  callee: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});

const contextIndexSchema = z.strictObject({
  schemaVersion: version("footgun.context-index.v1"),
  tool: z.strictObject({name: z.string().min(1), version: z.string().min(1)}),
  files: z.array(z.string().min(1)),
  definitions: z.array(contextDefinitionSchema),
  references: z.array(contextReferenceSchema),
  calls: z.array(contextCallSchema),
  coverage: z.strictObject({
    filesDiscovered: z.number().int().nonnegative(),
    filesIndexed: z.number().int().nonnegative(),
    parseStatus: z.enum(["complete", "partial", "unavailable"]),
    skippedFiles: z.array(z.string()),
  }),
  revision: z.string().nullable(),
  stale: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

const scanReportSchema = z.strictObject({
  schemaVersion: version("footgun.scan-report.v1"),
  tool: z.strictObject({name: z.literal("footgun"), version: z.string().min(1)}),
  repository: repositorySchema,
  inventory: inventorySchema.optional(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  findings: z.array(findingSchema),
  coverage: z.array(coverageSchema),
  context: contextIndexSchema.optional(),
  diagnostics: z.array(problemSchema),
  timings: timingsSchema,
  assumptions: z.array(z.string()),
  nextAction: z.string().optional(),
  filesModified: z.array(z.string()).default([]),
  rawArtifacts: z.array(z.string()),
});

const adapterManifestSchema = z.strictObject({
  schemaVersion: version("footgun.adapter-manifest.v1"),
  protocolVersion: z.literal("footgun.adapter.v1").default("footgun.adapter.v1"),
  id: z.string().min(1),
  version: z.string().min(1),
  command: z.array(z.string()).min(1),
  tool: z.strictObject({name: z.string().min(1), version: z.string().min(1)}).optional(),
  languages: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.string()),
  inputKinds: z.array(z.string().min(1)).default([]),
  outputKinds: z.array(z.string().min(1)).default([]),
  requirements: z.array(z.string().min(1)).default([]),
  sideEffects: z.array(z.enum(["read", "execute", "write", "network", "service", "resource"])).default(["execute"]),
  determinism: z.enum(["deterministic", "seeded", "environment-sensitive", "nondeterministic"]).default("environment-sensitive"),
  probeCommand: z.array(z.string()).min(1).optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  limits: z.strictObject({
    timeoutMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    maxArtifactBytes: z.number().int().positive(),
  }),
});

const adapterRequestSchema = z.strictObject({
  schemaVersion: version("footgun.adapter-request.v1"),
  requestId: z.string().min(1),
  root: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  operation: z.enum(["probe", "scan", "context", "benchmark", "profile", "trace"]).default("scan"),
  targets: z.array(z.string().min(1)).default([]),
  revision: z.string().nullable().default(null),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestedCapabilities: z.array(z.string().min(1)).default([]),
  executionPolicy: z.strictObject({network: z.enum(["disabled", "explicit"]), shell: z.literal(false), maxOutputBytes: z.number().int().positive()}).default({network: "disabled", shell: false, maxOutputBytes: 1_000_000}),
});

const adapterResultSchema = z.strictObject({
  schemaVersion: version("footgun.adapter-result.v1"),
  requestId: z.string().min(1),
  state: z.enum(["complete", "partial", "unavailable", "blocked", "failed", "cancelled"]),
  findings: z.array(findingSchema),
  coverage: z.array(coverageSchema),
  diagnostics: z.array(problemSchema),
  rawArtifacts: z.array(z.string()),
  rawArtifactDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  adapter: z.strictObject({id: z.string().min(1), version: z.string().min(1), command: z.array(z.string().min(1)), tool: z.strictObject({name: z.string().min(1), version: z.string().min(1)}).optional()}).optional(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reproduction: z.record(z.string(), z.unknown()).optional(),
});

const workloadSchema = z.strictObject({
  schemaVersion: version("footgun.workload.v1"),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  environment: z.record(z.string(), z.string()),
  inheritEnvironment: z.boolean(),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  inputSizeParameterization: z.strictObject({name: z.string().min(1), values: z.array(z.number().finite()).min(1), commandIndex: z.number().int().nonnegative()}).optional(),
  datasetDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  resourceLimits: z.strictObject({cpuMs: z.number().int().positive().optional(), memoryBytes: z.number().int().positive().optional(), maxProcesses: z.number().int().positive().optional()}).optional(),
  runner: z.strictObject({runtime: z.enum(["docker", "podman", "bwrap", "nsjail"]), image: z.string().min(1).optional()}).optional(),
  statisticalPolicy: z.strictObject({kind: z.enum(["median-improvement", "non-overlapping-iqr"]), minimumRelativeImprovement: z.number().nonnegative().max(1)}).default({kind: "median-improvement", minimumRelativeImprovement: 0}),
  requestedProfile: z.enum(["read-only", "local-exec", "service-exec", "container-exec", "candidate-write"]),
  expectedArtifacts: z.array(z.string().min(1)),
  behaviorChecks: z.array(z.string()),
  networkPolicy: z.enum(["disabled", "explicit"]).default("disabled"),
  candidateRoot: z.string().optional(),
});

const reproductionSchema = z.strictObject({
  command: z.array(z.string().min(1)),
  cwd: z.string().min(1),
  environmentKeys: z.array(z.string().min(1)),
  timeoutMs: z.number().int().positive(),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  expectedArtifacts: z.array(z.string().min(1)),
  datasetDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
});

const evidenceSchema = z.strictObject({
  schemaVersion: version("footgun.evidence.v1"),
  id: z.string().min(1),
  kind: z.enum(["static", "estimate", "measurement", "benchmark", "profile", "trace", "behavior", "context", "unknown"]),
  claimClass: z.enum(["static-fact", "theoretical-estimate", "empirical-scaling", "constant-factor", "system-bottleneck", "behavioral", "unknown"]).optional(),
  summary: z.string().min(1),
  artifact: z.string().optional(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  provenance: z.record(z.string(), z.string()).optional(),
});

const measurementSchema = z.strictObject({
  schemaVersion: version("footgun.measurement.v1"),
  id: z.string().regex(/^meas_[a-f0-9]{16}$/),
  investigation: z.string().optional(),
  workloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  samplesMs: z.array(z.number().nonnegative()).min(1),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  medianMs: z.number().nonnegative(),
  meanMs: z.number().nonnegative(),
  quartiles: z.strictObject({q1Ms: z.number().nonnegative(), q3Ms: z.number().nonnegative()}),
  statisticalPolicy: z.strictObject({kind: z.enum(["median-improvement", "non-overlapping-iqr"]), minimumRelativeImprovement: z.number().nonnegative().max(1)}),
  reproduction: reproductionSchema,
  behaviorValidated: z.boolean(),
  executionProfile: z.enum(["read-only", "local-exec", "service-exec", "container-exec", "candidate-write"]),
  environment: z.strictObject({node: z.string(), platform: z.string(), arch: z.string()}),
  isolation: z.strictObject({backend: z.enum(["host-process", "docker", "podman", "bwrap", "nsjail"]), controlsRequested: z.array(z.string()), controlsApplied: z.array(z.string()), downgradeReasons: z.array(z.string()), candidateWorkspace: z.string().optional(), runner: z.strictObject({runtime: z.enum(["docker", "podman", "bwrap", "nsjail"]), image: z.string().min(1).optional()}).optional()}),
  behaviorChecks: z.array(z.strictObject({check: z.string().min(1), passed: z.boolean(), observed: z.string().optional()})).optional(),
  artifact: z.string().optional(),
});

const benchmarkRecordSchema = z.strictObject({
  schemaVersion: version("footgun.benchmark-record.v1"),
  id: z.string().regex(/^bench_[a-f0-9]{16}$/),
  tool: z.enum(["hyperfine", "pyperf", "google-benchmark", "criterion", "jmh"]),
  name: z.string().min(1),
  samplesMs: z.array(z.number().nonnegative()).min(1),
  medianMs: z.number().nonnegative(),
  meanMs: z.number().nonnegative(),
  sourceUnit: z.string().min(1),
  rawArtifact: z.string().optional(),
  rawArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).default({}),
});

const benchmarkImportSchema = z.strictObject({
  schemaVersion: version("footgun.benchmark-import.v1"),
  tool: benchmarkRecordSchema.shape.tool,
  records: z.array(benchmarkRecordSchema).min(1),
  rawArtifact: z.string().optional(),
  rawArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

const profileSummarySchema = z.strictObject({
  schemaVersion: version("footgun.profile-summary.v1"),
  id: z.string().regex(/^prof_[a-f0-9]{16}$/),
  tool: z.literal("pprof"),
  sourceArtifact: z.string().min(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sampleTypes: z.array(z.strictObject({type: z.string(), unit: z.string()})),
  sampleCount: z.number().int().nonnegative(),
  locationCount: z.number().int().nonnegative(),
  mappingCount: z.number().int().nonnegative(),
  functionCount: z.number().int().nonnegative(),
  topFunctions: z.array(z.strictObject({name: z.string().min(1), value: z.number().finite(), unit: z.string()})),
  limitations: z.array(z.string()),
});

const traceSummarySchema = z.strictObject({
  schemaVersion: version("footgun.trace-summary.v1"),
  id: z.string().regex(/^trace_[a-f0-9]{16}$/),
  tool: z.literal("perfetto"),
  sourceArtifact: z.string().min(1),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  query: z.string().min(1).optional(),
  columns: z.array(z.string().min(1)),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))),
  limitations: z.array(z.string()),
});

const scalingPointSchema = z.strictObject({
  value: z.number().finite(),
  status: z.enum(["complete", "timed-out", "failed"]),
  samplesMs: z.array(z.number().nonnegative()),
  medianMs: z.number().nonnegative(),
  meanMs: z.number().nonnegative(),
  quartiles: z.strictObject({q1Ms: z.number().nonnegative(), q3Ms: z.number().nonnegative()}),
  statisticalPolicy: z.strictObject({kind: z.enum(["median-improvement", "non-overlapping-iqr"]), minimumRelativeImprovement: z.number().nonnegative().max(1)}),
  timedOut: z.boolean(),
  behaviorValidated: z.boolean(),
  diagnostic: z.string().optional(),
});

const scalingModelSchema = z.strictObject({
  name: z.enum(["constant", "logarithmic", "linear", "linearithmic", "quadratic"]),
  coefficients: z.array(z.number().finite()),
  residual: z.number().nonnegative(),
  rSquared: z.number().finite(),
});

const scalingSchema = z.strictObject({
  schemaVersion: version("footgun.scaling.v1"),
  id: z.string().regex(/^scale_[a-f0-9]{16}$/),
  investigation: z.string().optional(),
  workloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parameter: z.string().min(1),
  points: z.array(scalingPointSchema).min(1),
  models: z.array(scalingModelSchema),
  selectedModel: scalingModelSchema.shape.name.optional(),
  reproduction: reproductionSchema,
  environment: z.strictObject({node: z.string(), platform: z.string(), arch: z.string()}),
  limitations: z.array(z.string()),
  artifact: z.string().optional(),
});

const comparisonSchema = z.strictObject({
  schemaVersion: version("footgun.comparison.v1"),
  id: z.string().regex(/^cmp_[a-f0-9]{16}$/),
  mode: z.enum(["measurement", "scaling"]),
  baseline: z.string().min(1),
  candidate: z.string().min(1),
  workloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  behaviorValidated: z.boolean(),
  improvement: z.boolean(),
  baselineMedianMs: z.number().nonnegative().optional(),
  candidateMedianMs: z.number().nonnegative().optional(),
  deltaPercent: z.number().finite().optional(),
  statisticalPolicy: z.strictObject({kind: z.enum(["median-improvement", "non-overlapping-iqr"]), minimumRelativeImprovement: z.number().nonnegative().max(1)}).optional(),
  points: z.array(z.strictObject({value: z.number().finite(), baselineMedianMs: z.number().nonnegative(), candidateMedianMs: z.number().nonnegative(), deltaPercent: z.number().finite(), improvement: z.boolean(), statisticalPolicy: z.strictObject({kind: z.enum(["median-improvement", "non-overlapping-iqr"]), minimumRelativeImprovement: z.number().nonnegative().max(1)})})).optional(),
  baselineModel: scalingModelSchema.shape.name.optional(),
  candidateModel: scalingModelSchema.shape.name.optional(),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  comparability: z.strictObject({status: z.enum(["comparable", "cross-machine", "inconclusive"]), reasons: z.array(z.string())}).optional(),
  promotion: z.enum(["eligible", "blocked", "inconclusive"]).optional(),
  promotionReasons: z.array(z.string()).optional(),
});

const investigationSchema = z.strictObject({
  schemaVersion: version("footgun.investigation-bundle.v1"),
  id: z.string().regex(/^inv_[a-f0-9]{16}$/),
  state: z.enum(["created", "inventoried", "scanned", "context-resolved", "measurement-planned", "baseline-measured", "candidate-compared", "behavior-validated", "reported", "blocked", "inconclusive", "unavailable", "cancelled", "failed"]),
  root: z.string().min(1),
  repository: repositorySchema.optional(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.string().datetime({offset: true}),
  findingIds: z.array(z.string().regex(/^fg_[a-f0-9]{16}$/)).optional(),
  callers: z.array(z.string()).default([]),
  inputs: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  workloads: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  versions: z.record(z.string(), z.string()).default({}),
  reports: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  diagnostics: z.array(problemSchema),
});

const investigationPointerSchema = z.strictObject({
  schemaVersion: version("footgun.investigation-pointer.v1"),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime({offset: true}),
});

export type LocationV1 = z.infer<typeof locationSchema>;
export type ProblemV1 = z.infer<typeof problemSchema>;
export type ActionRequiredV1 = z.infer<typeof actionRequiredSchema>;
export type CoverageRecordV1 = z.infer<typeof coverageSchema>;
export type FindingV1 = z.infer<typeof findingSchema>;
export type RepositoryInventoryV1 = z.infer<typeof inventorySchema>;
export type ContextDefinitionV1 = z.infer<typeof contextDefinitionSchema>;
export type ContextReferenceV1 = z.infer<typeof contextReferenceSchema>;
export type ContextCallV1 = z.infer<typeof contextCallSchema>;
export type ContextIndexV1 = z.infer<typeof contextIndexSchema>;
export type ScanReportV1 = z.infer<typeof scanReportSchema>;
export type AdapterManifestV1 = z.infer<typeof adapterManifestSchema>;
export type AdapterRequestV1 = z.infer<typeof adapterRequestSchema>;
export type AdapterResultV1 = z.infer<typeof adapterResultSchema>;
export type WorkloadV1 = z.infer<typeof workloadSchema>;
export type EvidenceRecordV1 = z.infer<typeof evidenceSchema>;
export type MeasurementV1 = z.infer<typeof measurementSchema>;
export type BenchmarkRecordV1 = z.infer<typeof benchmarkRecordSchema>;
export type BenchmarkImportV1 = z.infer<typeof benchmarkImportSchema>;
export type ProfileSummaryV1 = z.infer<typeof profileSummarySchema>;
export type TraceSummaryV1 = z.infer<typeof traceSummarySchema>;
export type ScalingPointV1 = z.infer<typeof scalingPointSchema>;
export type ScalingModelV1 = z.infer<typeof scalingModelSchema>;
export type ScalingAnalysisV1 = z.infer<typeof scalingSchema>;
export type ComparisonV1 = z.infer<typeof comparisonSchema>;
export type InvestigationBundleV1 = z.infer<typeof investigationSchema>;
export type InvestigationPointerV1 = z.infer<typeof investigationPointerSchema>;

export const Protocol = {
  location: locationSchema,
  problem: problemSchema,
  actionRequired: actionRequiredSchema,
  coverage: coverageSchema,
  finding: findingSchema,
  inventory: inventorySchema,
  contextIndex: contextIndexSchema,
  scanReport: scanReportSchema,
  adapterManifest: adapterManifestSchema,
  adapterRequest: adapterRequestSchema,
  adapterResult: adapterResultSchema,
  workload: workloadSchema,
  evidence: evidenceSchema,
  measurement: measurementSchema,
  benchmarkRecord: benchmarkRecordSchema,
  benchmarkImport: benchmarkImportSchema,
  profileSummary: profileSummarySchema,
  traceSummary: traceSummarySchema,
  scaling: scalingSchema,
  comparison: comparisonSchema,
  investigation: investigationSchema,
  investigationPointer: investigationPointerSchema,
};

/** Parse an untrusted JSON value as a versioned scan report. */
export type ProtocolProblemV1 = ProblemV1 & {_tag: "ProtocolProblem"};

export function parseScanReport(input: unknown): ScanReportV1 | ProtocolProblemV1 {
  const result = scanReportSchema.safeParse(input);
  if (result.success) return result.data;
  return {
    _tag: "ProtocolProblem",
    schemaVersion: "footgun.problem.v1",
    code: "invalid-scan-report",
    message: "The input is not a valid Footgun ScanReportV1.",
    detail: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    recovery: "Regenerate the artifact with `footgun scan <path> --format json`.",
  };
}
