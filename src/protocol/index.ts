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

const evidenceSchema = z
  .strictObject({
    schemaVersion: version("footgun.evidence.v2"),
    id: z.string().min(1),
    kind: z.enum([
      "static",
      "estimate",
      "measurement",
      "benchmark",
      "profile",
      "trace",
      "behavior",
      "context",
      "unknown",
    ]),
    claimClass: z
      .enum([
        "static-fact",
        "theoretical-estimate",
        "empirical-scaling",
        "constant-factor",
        "system-bottleneck",
        "behavioral",
        "unknown",
      ])
      .optional(),
    summary: z.string().min(1),
    artifact: z.string().optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    provenance: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((evidence, context) => {
    if (evidence.digest !== undefined && evidence.artifact === undefined)
      context.addIssue({
        code: "custom",
        message: "An evidence digest requires an artifact reference.",
        path: ["digest"],
      });
  });

const findingSchema = z.strictObject({
  schemaVersion: version("footgun.finding.v2"),
  id: z.string().regex(/^fg_[a-f0-9]{16}$/),
  scanner: z.string().min(1),
  scannerVersion: z.string().min(1),
  ruleId: z.string().min(1),
  language: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  claimClass: z
    .enum([
      "static-fact",
      "theoretical-estimate",
      "empirical-scaling",
      "constant-factor",
      "system-bottleneck",
      "behavioral",
      "unknown",
    ])
    .optional(),
  severity: z.enum(["high", "medium", "low", "info"]),
  confidence: z.enum(["candidate", "type-informed", "verified", "unknown"]),
  status: z
    .enum(["unvalidated", "supported", "measured", "rejected", "blocked", "inconclusive"])
    .default("unvalidated"),
  relatedFindings: z.array(z.string().regex(/^fg_[a-f0-9]{16}$/)).default([]),
  message: z.string().min(1),
  suggestion: z.string().min(1),
  location: locationSchema,
  assumptions: z.array(z.string()),
  evidence: z.array(z.string()),
  evidenceRecords: z.array(evidenceSchema).optional(),
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
  languages: z.array(
    z.strictObject({
      language: z.string().min(1),
      files: z.number().int().nonnegative(),
      extensions: z.array(z.string().min(1)),
    }),
  ),
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

const scanReportSchema = z
  .strictObject({
    schemaVersion: version("footgun.scan-report.v2"),
    tool: z.strictObject({name: z.enum(["footgun", "smokinggun"]), version: z.string().min(1)}),
    repository: repositorySchema,
    inventory: inventorySchema.optional(),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
    rawArtifactDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  })
  .superRefine((report, context) => {
    for (const artifact of Object.keys(report.rawArtifactDigests ?? {}))
      if (!report.rawArtifacts.includes(artifact))
        context.addIssue({
          code: "custom",
          message: "An artifact digest requires a matching rawArtifacts entry.",
          path: ["rawArtifactDigests", artifact],
        });
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
  determinism: z
    .enum(["deterministic", "seeded", "environment-sensitive", "nondeterministic"])
    .default("environment-sensitive"),
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
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  configDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  requestedCapabilities: z.array(z.string().min(1)).default([]),
  executionPolicy: z
    .strictObject({
      network: z.enum(["disabled", "explicit"]),
      shell: z.literal(false),
      maxOutputBytes: z.number().int().positive(),
    })
    .default({network: "disabled", shell: false, maxOutputBytes: 1_000_000}),
});

const adapterResultSchema = z
  .strictObject({
    schemaVersion: version("footgun.adapter-result.v2"),
    requestId: z.string().min(1),
    state: z.enum(["complete", "partial", "unavailable", "blocked", "failed", "cancelled"]),
    findings: z.array(findingSchema),
    coverage: z.array(coverageSchema),
    diagnostics: z.array(problemSchema),
    rawArtifacts: z.array(z.string()),
    rawArtifactDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
    adapter: z
      .strictObject({
        id: z.string().min(1),
        version: z.string().min(1),
        command: z.array(z.string().min(1)),
        tool: z.strictObject({name: z.string().min(1), version: z.string().min(1)}).optional(),
      })
      .optional(),
    requestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    configDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reproduction: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((result, context) => {
    for (const artifact of Object.keys(result.rawArtifactDigests))
      if (!result.rawArtifacts.includes(artifact))
        context.addIssue({
          code: "custom",
          message: "An artifact digest requires a matching rawArtifacts entry.",
          path: ["rawArtifactDigests", artifact],
        });
  });

const workloadFields = {
  schemaVersion: version("footgun.workload.v2"),
  command: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  environment: z.record(z.string(), z.string()),
  inheritEnvironment: z.boolean(),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  datasetDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  resourceLimits: z
    .strictObject({
      cpuMs: z.number().int().positive().optional(),
      memoryBytes: z.number().int().positive().optional(),
      maxProcesses: z.number().int().positive().optional(),
    })
    .optional(),
  runner: z
    .strictObject({runtime: z.enum(["docker", "podman", "bwrap", "nsjail"]), image: z.string().min(1).optional()})
    .optional(),
  statisticalPolicy: z
    .strictObject({
      kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
      minimumRelativeImprovement: z.number().nonnegative().max(1),
    })
    .default({kind: "median-improvement", minimumRelativeImprovement: 0}),
  requestedProfile: z.enum(["read-only", "local-exec", "service-exec", "container-exec", "candidate-write"]),
  expectedArtifacts: z.array(z.string().min(1)),
  behaviorChecks: z.array(z.string()),
  networkPolicy: z.enum(["disabled", "explicit"]).default("disabled"),
  candidateRoot: z.string().optional(),
};

const parameterSchema = z.strictObject({
  name: z.string().min(1),
  values: z.array(z.number().finite()).min(1),
  commandIndex: z.number().int().nonnegative(),
});

const singleParameterizationSchema = parameterSchema;

const multiParameterizationSchema = z
  .strictObject({
    parameters: z.array(parameterSchema).length(2),
    coordinates: z.array(z.record(z.string(), z.number().finite())).min(1).optional(),
    maxPoints: z.number().int().positive().max(64),
  })
  .superRefine((design, context) => {
    const names = design.parameters.map((parameter) => parameter.name);
    const commandIndexes = design.parameters.map((parameter) => parameter.commandIndex);
    if (new Set(names).size !== names.length)
      context.addIssue({code: "custom", message: "Scaling parameter names must be distinct.", path: ["parameters"]});
    if (new Set(commandIndexes).size !== commandIndexes.length)
      context.addIssue({
        code: "custom",
        message: "Scaling parameter command indexes must be distinct.",
        path: ["parameters"],
      });
    if (design.coordinates !== undefined)
      for (const [index, coordinate] of design.coordinates.entries()) {
        const coordinateNames = Object.keys(coordinate);
        if (coordinateNames.length !== names.length || !names.every((name) => Number.isFinite(coordinate[name])))
          context.addIssue({
            code: "custom",
            message: "Every coordinate must contain exactly the declared numeric parameter names.",
            path: ["coordinates", index],
          });
      }
  });

const unparameterizedWorkloadSchema = z.strictObject(workloadFields);
const singleScalingWorkloadSchema = z
  .strictObject({...workloadFields, inputSizeParameterization: singleParameterizationSchema})
  .superRefine((workload, context) => {
    if (workload.inputSizeParameterization.commandIndex >= workload.command.length)
      context.addIssue({
        code: "custom",
        message: "The input-size command index must reference a declared command argument.",
        path: ["inputSizeParameterization", "commandIndex"],
      });
  });
const multiScalingWorkloadSchema = z
  .strictObject({...workloadFields, multiParameterization: multiParameterizationSchema})
  .superRefine((workload, context) => {
    const {parameters, coordinates, maxPoints} = workload.multiParameterization;
    if (parameters.some((parameter) => parameter.commandIndex >= workload.command.length))
      context.addIssue({
        code: "custom",
        message: "Every scaling command index must reference a declared command argument.",
        path: ["multiParameterization", "parameters"],
      });
    const coordinateCount =
      coordinates?.length ?? parameters.reduce((count, parameter) => count * parameter.values.length, 1);
    if (coordinateCount > maxPoints)
      context.addIssue({
        code: "custom",
        message: "The scaling coordinate plan exceeds maxPoints.",
        path: ["multiParameterization", "maxPoints"],
      });
  });

const workloadSchema = z.union([
  unparameterizedWorkloadSchema,
  singleScalingWorkloadSchema,
  multiScalingWorkloadSchema,
]);

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
  statisticalPolicy: z.strictObject({
    kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
    minimumRelativeImprovement: z.number().nonnegative().max(1),
  }),
  reproduction: reproductionSchema,
  behaviorValidated: z.boolean(),
  executionProfile: z.enum(["read-only", "local-exec", "service-exec", "container-exec", "candidate-write"]),
  environment: z.strictObject({node: z.string(), platform: z.string(), arch: z.string()}),
  isolation: z.strictObject({
    backend: z.enum(["host-process", "docker", "podman", "bwrap", "nsjail"]),
    controlsRequested: z.array(z.string()),
    controlsApplied: z.array(z.string()),
    downgradeReasons: z.array(z.string()),
    candidateWorkspace: z.string().optional(),
    runner: z
      .strictObject({runtime: z.enum(["docker", "podman", "bwrap", "nsjail"]), image: z.string().min(1).optional()})
      .optional(),
  }),
  behaviorChecks: z
    .array(z.strictObject({check: z.string().min(1), passed: z.boolean(), observed: z.string().optional()}))
    .optional(),
  artifact: z.string().optional(),
});

const benchmarkRecordSchema = z
  .strictObject({
    schemaVersion: version("footgun.benchmark-record.v2"),
    id: z.string().regex(/^bench_[a-f0-9]{16}$/),
    tool: z.enum(["hyperfine", "pyperf", "google-benchmark", "criterion", "jmh"]),
    name: z.string().min(1),
    samplesMs: z.array(z.number().nonnegative()).min(1),
    medianMs: z.number().nonnegative(),
    meanMs: z.number().nonnegative(),
    sourceUnit: z.string().min(1),
    rawArtifact: z.string().optional(),
    rawArtifactDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).default({}),
  })
  .superRefine((record, context) => {
    if (record.rawArtifactDigest !== undefined && record.rawArtifact === undefined)
      context.addIssue({
        code: "custom",
        message: "A raw artifact digest requires a rawArtifact reference.",
        path: ["rawArtifactDigest"],
      });
  });

const benchmarkImportSchema = z
  .strictObject({
    schemaVersion: version("footgun.benchmark-import.v2"),
    tool: benchmarkRecordSchema.shape.tool,
    records: z.array(benchmarkRecordSchema).min(1),
    rawArtifact: z.string().optional(),
    rawArtifactDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((benchmark, context) => {
    if (benchmark.rawArtifactDigest !== undefined && benchmark.rawArtifact === undefined)
      context.addIssue({
        code: "custom",
        message: "A raw artifact digest requires a rawArtifact reference.",
        path: ["rawArtifactDigest"],
      });
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

const scalingPointFields = {
  value: z.number().finite(),
  statisticalPolicy: z.strictObject({
    kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
    minimumRelativeImprovement: z.number().nonnegative().max(1),
  }),
  behaviorValidated: z.boolean(),
  isolation: measurementSchema.shape.isolation.optional(),
  diagnostic: z.string().optional(),
};

const completedScalingPointSchema = z.strictObject({
  ...scalingPointFields,
  status: z.literal("complete"),
  samplesMs: z.array(z.number().nonnegative()).min(1),
  medianMs: z.number().nonnegative(),
  meanMs: z.number().nonnegative(),
  quartiles: z.strictObject({q1Ms: z.number().nonnegative(), q3Ms: z.number().nonnegative()}),
  timedOut: z.literal(false),
});

const failedScalingPointFields = {
  ...scalingPointFields,
  samplesMs: z.array(z.number().nonnegative()).length(0),
  medianMs: z.literal(0),
  meanMs: z.literal(0),
  quartiles: z.strictObject({q1Ms: z.literal(0), q3Ms: z.literal(0)}),
};

const timedOutScalingPointSchema = z.strictObject({
  ...failedScalingPointFields,
  status: z.literal("timed-out"),
  timedOut: z.literal(true),
});

const failedScalingPointSchema = z.strictObject({
  ...failedScalingPointFields,
  status: z.literal("failed"),
  timedOut: z.literal(false),
});

const cancelledScalingPointSchema = z.strictObject({
  ...failedScalingPointFields,
  status: z.literal("cancelled"),
  timedOut: z.literal(false),
});

const scalingPointSchema = z.discriminatedUnion("status", [
  completedScalingPointSchema,
  timedOutScalingPointSchema,
  failedScalingPointSchema,
]);

const scalingModelSchema = z.strictObject({
  name: z.enum(["constant", "logarithmic", "linear", "linearithmic", "quadratic"]),
  coefficients: z.array(z.number().finite()),
  residual: z.number().nonnegative(),
  rSquared: z.number().finite(),
});

const scalingSchema = z.strictObject({
  schemaVersion: version("footgun.scaling.v2"),
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

const multiScalingPointSchema = z.discriminatedUnion("status", [
  completedScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
  timedOutScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
  failedScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
  cancelledScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
]);

const multiScalingSchema = z.strictObject({
  schemaVersion: version("footgun.scaling.v3"),
  id: z.string().regex(/^scale_[a-f0-9]{16}$/),
  investigation: z.string().optional(),
  workloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parameters: z.array(z.string().min(1)).min(2).max(2),
  coordinatesDigest: z.string().regex(/^[a-f0-9]{64}$/),
  points: z.array(multiScalingPointSchema).min(1),
  reproduction: reproductionSchema,
  environment: z.strictObject({node: z.string(), platform: z.string(), arch: z.string()}),
  limitations: z.array(z.string()),
  artifact: z.string().optional(),
});

const comparisonPointSchema = z.strictObject({
  value: z.number().finite(),
  coordinates: z.record(z.string(), z.number().finite()).optional(),
  baselineMedianMs: z.number().nonnegative(),
  candidateMedianMs: z.number().nonnegative(),
  deltaPercent: z.number().finite(),
  improvement: z.boolean(),
  statisticalPolicy: z.strictObject({
    kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
    minimumRelativeImprovement: z.number().nonnegative().max(1),
  }),
});

const comparisonFields = {
  schemaVersion: version("footgun.comparison.v2"),
  id: z.string().regex(/^cmp_[a-f0-9]{16}$/),
  baseline: z.string().min(1),
  candidate: z.string().min(1),
  workloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  behaviorValidated: z.boolean(),
  improvement: z.boolean(),
  statisticalPolicy: z.strictObject({
    kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
    minimumRelativeImprovement: z.number().nonnegative().max(1),
  }),
  comparability: z
    .strictObject({status: z.enum(["comparable", "cross-machine", "inconclusive"]), reasons: z.array(z.string())})
    .optional(),
  promotion: z.enum(["eligible", "blocked", "inconclusive"]).optional(),
  promotionReasons: z.array(z.string()).optional(),
};

const comparisonDigestFields = {
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
};

const measurementComparisonSchema = z.strictObject({
  ...comparisonFields,
  mode: z.literal("measurement"),
  baselineMedianMs: z.number().nonnegative(),
  candidateMedianMs: z.number().nonnegative(),
  deltaPercent: z.number().finite(),
});

const scalingComparisonSchema = z.strictObject({
  ...comparisonFields,
  mode: z.literal("scaling"),
  points: z.array(comparisonPointSchema).min(1),
  baselineModel: scalingModelSchema.shape.name.optional(),
  candidateModel: scalingModelSchema.shape.name.optional(),
});

const measurementComparisonWithDigestsSchema = z.strictObject({
  ...comparisonFields,
  ...comparisonDigestFields,
  mode: z.literal("measurement"),
  baselineMedianMs: z.number().nonnegative(),
  candidateMedianMs: z.number().nonnegative(),
  deltaPercent: z.number().finite(),
});

const scalingComparisonWithDigestsSchema = z.strictObject({
  ...comparisonFields,
  ...comparisonDigestFields,
  mode: z.literal("scaling"),
  points: z.array(comparisonPointSchema).min(1),
  baselineModel: scalingModelSchema.shape.name.optional(),
  candidateModel: scalingModelSchema.shape.name.optional(),
});

const comparisonSchema = z.union([
  z.discriminatedUnion("mode", [measurementComparisonSchema, scalingComparisonSchema]),
  z.discriminatedUnion("mode", [measurementComparisonWithDigestsSchema, scalingComparisonWithDigestsSchema]),
]);

const investigationSchema = z.strictObject({
  schemaVersion: version("footgun.investigation-bundle.v2"),
  id: z.string().regex(/^inv_[a-f0-9]{16}$/),
  state: z.enum([
    "created",
    "inventoried",
    "scanned",
    "context-resolved",
    "measurement-planned",
    "baseline-measured",
    "candidate-compared",
    "behavior-validated",
    "reported",
    "blocked",
    "inconclusive",
    "unavailable",
    "cancelled",
    "failed",
  ]),
  root: z.string().min(1),
  repository: repositorySchema.optional(),
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
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
export type FindingV2 = z.infer<typeof findingSchema>;
export type RepositoryInventoryV1 = z.infer<typeof inventorySchema>;
export type ContextDefinitionV1 = z.infer<typeof contextDefinitionSchema>;
export type ContextReferenceV1 = z.infer<typeof contextReferenceSchema>;
export type ContextCallV1 = z.infer<typeof contextCallSchema>;
export type ContextIndexV1 = z.infer<typeof contextIndexSchema>;
export type ScanReportV2 = z.infer<typeof scanReportSchema>;
export type AdapterManifestV1 = z.infer<typeof adapterManifestSchema>;
export type AdapterRequestV1 = z.infer<typeof adapterRequestSchema>;
export type AdapterResultV2 = z.infer<typeof adapterResultSchema>;
export type WorkloadV2 = z.infer<typeof workloadSchema>;
export type SingleScalingWorkloadV2 = z.infer<typeof singleScalingWorkloadSchema>;
export type MultiScalingWorkloadV2 = z.infer<typeof multiScalingWorkloadSchema>;
export type EvidenceRecordV2 = z.infer<typeof evidenceSchema>;
export type MeasurementV1 = z.infer<typeof measurementSchema>;
export type BenchmarkRecordV2 = z.infer<typeof benchmarkRecordSchema>;
export type BenchmarkImportV2 = z.infer<typeof benchmarkImportSchema>;
export type ProfileSummaryV1 = z.infer<typeof profileSummarySchema>;
export type TraceSummaryV1 = z.infer<typeof traceSummarySchema>;
export type ScalingPointV2 = z.infer<typeof scalingPointSchema>;
export type ScalingModelV1 = z.infer<typeof scalingModelSchema>;
export type ScalingAnalysisV2 = z.infer<typeof scalingSchema>;
export type ScalingAnalysisV3 = z.infer<typeof multiScalingSchema>;
export type ComparisonV2 = z.infer<typeof comparisonSchema>;
export type MeasurementComparisonV2 =
  | z.infer<typeof measurementComparisonSchema>
  | z.infer<typeof measurementComparisonWithDigestsSchema>;
export type ScalingComparisonV2 =
  | z.infer<typeof scalingComparisonSchema>
  | z.infer<typeof scalingComparisonWithDigestsSchema>;
export type InvestigationBundleV2 = z.infer<typeof investigationSchema>;
export type InvestigationPointerV1 = z.infer<typeof investigationPointerSchema>;

/** Narrow a parsed workload to its single-parameter scaling form. */
export function isSingleScalingWorkload(workload: WorkloadV2): workload is SingleScalingWorkloadV2 {
  return "inputSizeParameterization" in workload;
}

/** Narrow a parsed workload to its two-parameter scaling form. */
export function isMultiScalingWorkload(workload: WorkloadV2): workload is MultiScalingWorkloadV2 {
  return "multiParameterization" in workload;
}

/** Return whether a parsed workload belongs to either scaling runner. */
export function isScalingWorkload(workload: WorkloadV2): boolean {
  return isSingleScalingWorkload(workload) || isMultiScalingWorkload(workload);
}

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
  scalingPoint: scalingPointSchema,
  scaling: scalingSchema,
  multiScaling: multiScalingSchema,
  comparison: comparisonSchema,
  investigation: investigationSchema,
  investigationPointer: investigationPointerSchema,
};

/** Parse an untrusted JSON value as a versioned scan report. */
export type ProtocolProblemV1 = ProblemV1 & {_tag: "ProtocolProblem"};

export function parseScanReport(input: unknown): ScanReportV2 | ProtocolProblemV1 {
  const result = scanReportSchema.safeParse(input);
  if (result.success) return result.data;
  return {
    _tag: "ProtocolProblem",
    schemaVersion: "footgun.problem.v1",
    code: "invalid-scan-report",
    message: "The input is not a valid SmokingGun ScanReportV2.",
    detail: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    recovery: "Regenerate the artifact with `smokinggun scan <path> --format json`.",
  };
}
