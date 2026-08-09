import {createHash} from "node:crypto";
import {z} from "zod";
import {canonicalJson} from "./canonical-json.js";

const version = <const T extends string>(value: T) => z.literal(value);

function isRepositoryRelativePath(path: string): boolean {
  return (
    !path.includes("\0") &&
    !/^(?:[A-Za-z]:)?[\\/]/.test(path) &&
    !/^[A-Za-z]:/.test(path) &&
    path.split(/[\\/]+/).every((segment) => segment !== "..")
  );
}

function isPortableRepositoryPath(path: string): boolean {
  return (
    isRepositoryRelativePath(path) &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== ".")
  );
}

const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .refine(isRepositoryRelativePath, "Path must remain relative to the repository root.");
const repositoryChildPathSchema = repositoryRelativePathSchema.refine(
  (path) => path !== ".",
  "Path must name a child of the repository root.",
);
const portableRepositoryPathSchema = z
  .string()
  .min(1)
  .refine(isPortableRepositoryPath, "Path must be a canonical portable repository-relative path.");
const portableRepositoryChildPathSchema = portableRepositoryPathSchema.refine(
  (path) => path !== ".",
  "Path must name a child of the repository root.",
);

const locationSchema = z.strictObject({
  path: portableRepositoryChildPathSchema,
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
  path: portableRepositoryPathSchema.optional(),
  recovery: z.string().optional(),
});

const actionRequiredSchema = z.strictObject({
  schemaVersion: version("footgun.action-required.v1"),
  reason: z.string().min(1),
  explanation: z.string().min(1),
  recoveryCommands: z.array(z.string()),
});

const coverageFields = {
  scanner: z.string().min(1),
  version: z.string().min(1),
  language: z.string().min(1),
  filesDiscovered: z.number().int().nonnegative(),
  filesAnalyzed: z.number().int().nonnegative(),
  skippedFiles: z.array(portableRepositoryChildPathSchema),
};

const completeCoverageSchema = z.strictObject({
  ...coverageFields,
  parseStatus: z.literal("complete"),
  reason: z.string().min(1).optional(),
});

const partialCoverageSchema = z.strictObject({
  ...coverageFields,
  parseStatus: z.literal("partial"),
  reason: z.string().min(1),
});
const failedCoverageSchema = z.strictObject({
  ...coverageFields,
  parseStatus: z.literal("failed"),
  reason: z.string().min(1),
});
const unavailableCoverageSchema = z.strictObject({
  ...coverageFields,
  parseStatus: z.literal("unavailable"),
  reason: z.string().min(1),
});

const coverageSchema = z
  .discriminatedUnion("parseStatus", [
    completeCoverageSchema,
    partialCoverageSchema,
    failedCoverageSchema,
    unavailableCoverageSchema,
  ])
  .superRefine((coverage, context) => {
    if (coverage.filesAnalyzed > coverage.filesDiscovered)
      context.addIssue({
        code: "custom",
        path: ["filesAnalyzed"],
        message: "Coverage cannot analyze more files than it discovered.",
      });
    if (coverage.parseStatus === "complete" && coverage.filesAnalyzed !== coverage.filesDiscovered)
      context.addIssue({
        code: "custom",
        path: ["filesAnalyzed"],
        message: "Complete coverage must analyze every discovered file.",
      });
    if (coverage.parseStatus === "complete" && coverage.skippedFiles.length > 0)
      context.addIssue({
        code: "custom",
        path: ["skippedFiles"],
        message: "Complete coverage cannot list skipped files.",
      });
    if (new Set(coverage.skippedFiles).size !== coverage.skippedFiles.length)
      context.addIssue({
        code: "custom",
        path: ["skippedFiles"],
        message: "Skipped coverage paths must be unique.",
      });
  });

const evidenceFields = {
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
  provenance: z.record(z.string(), z.string()).optional(),
};

const evidenceSchema = z.union([
  z.strictObject({
    ...evidenceFields,
    artifact: z.string().min(1),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  z.strictObject({
    ...evidenceFields,
    artifact: z.never().optional(),
    digest: z.never().optional(),
  }),
]);

const findingSchema = z
  .strictObject({
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
  })
  .superRefine((finding, context) => {
    if (finding.relatedFindings.includes(finding.id))
      context.addIssue({code: "custom", path: ["relatedFindings"], message: "A finding cannot relate to itself."});
    if (new Set(finding.relatedFindings).size !== finding.relatedFindings.length)
      context.addIssue({code: "custom", path: ["relatedFindings"], message: "Related finding IDs must be unique."});
  });

function requireUniqueFindingIds(findings: ReadonlyArray<{readonly id: string}>, context: z.RefinementCtx): void {
  const ids = new Set<string>();
  for (const [index, finding] of findings.entries()) {
    if (ids.has(finding.id))
      context.addIssue({code: "custom", path: ["findings", index, "id"], message: "Finding IDs must be unique."});
    ids.add(finding.id);
  }
}

function requireRetainedFindingRelations(
  findings: ReadonlyArray<{readonly relatedFindings: ReadonlyArray<string>} & {readonly id: string}>,
  context: z.RefinementCtx,
): void {
  const ids = new Set(findings.map((finding) => finding.id));
  for (const [findingIndex, finding] of findings.entries())
    for (const [relationIndex, relatedId] of finding.relatedFindings.entries())
      if (!ids.has(relatedId))
        context.addIssue({
          code: "custom",
          path: ["findings", findingIndex, "relatedFindings", relationIndex],
          message: "Related findings must be retained in the same report.",
        });
}

function requireUniqueCoverageRecords(
  coverage: ReadonlyArray<{readonly scanner: string; readonly version: string; readonly language: string}>,
  context: z.RefinementCtx,
): void {
  const identities = new Set<string>();
  for (const [index, record] of coverage.entries()) {
    const identity = `${record.scanner}\0${record.version}\0${record.language}`;
    if (identities.has(identity))
      context.addIssue({
        code: "custom",
        path: ["coverage", index],
        message: "Coverage records must be unique per scanner, version, and language.",
      });
    identities.add(identity);
  }
}

function requireUniqueStrings(values: ReadonlyArray<string>, context: z.RefinementCtx, field: string): Set<string> {
  const unique = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (unique.has(value))
      context.addIssue({code: "custom", path: [field, index], message: `${field} entries must be unique.`});
    unique.add(value);
  }
  return unique;
}

const timingsSchema = z.strictObject({
  startedAt: z.string().datetime({offset: true}),
  durationMs: z.number().nonnegative(),
});

const rawArtifactSchema = z.string().min(1);

const commandSchema = z
  .array(z.string())
  .min(1)
  .refine(
    ([executable]) => executable !== undefined && executable.length > 0,
    "A command requires a non-empty executable.",
  );

function uniqueRepositoryChildPaths(message: string): z.ZodArray<typeof portableRepositoryChildPathSchema> {
  return z.array(portableRepositoryChildPathSchema).refine((paths) => new Set(paths).size === paths.length, message);
}

const repositorySchema = z.strictObject({
  root: z.string().min(1),
  revision: z.string().nullable(),
  dirty: z.boolean(),
});

const inventorySchema = z
  .strictObject({
    schemaVersion: version("footgun.repository-inventory.v1"),
    languages: z.array(
      z.strictObject({
        language: z.string().min(1),
        files: z.number().int().nonnegative(),
        extensions: uniqueNonemptyStrings("Language extensions must be unique."),
      }),
    ),
    manifests: uniqueRepositoryChildPaths("Repository manifests must be unique."),
    packageManagers: uniqueNonemptyStrings("Package managers must be unique."),
    tests: uniqueRepositoryChildPaths("Repository tests must be unique."),
    benchmarks: uniqueRepositoryChildPaths("Repository benchmarks must be unique."),
    generated: uniqueRepositoryChildPaths("Generated source paths must be unique."),
    ignored: uniqueRepositoryChildPaths("Ignored source paths must be unique."),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((inventory, context) => {
    const languages = new Set<string>();
    for (const [index, language] of inventory.languages.entries()) {
      if (languages.has(language.language))
        context.addIssue({
          code: "custom",
          path: ["languages", index, "language"],
          message: "Repository language records must be unique.",
        });
      languages.add(language.language);
    }
  });

const contextDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  path: portableRepositoryChildPathSchema,
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  type: z.string().optional(),
  alias: z.string().optional(),
});

const contextReferenceSchema = z.strictObject({
  name: z.string().min(1),
  path: portableRepositoryChildPathSchema,
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
  resolved: z.boolean(),
  alias: z.string().optional(),
});

const contextCallSchema = z.strictObject({
  callee: z.string().min(1),
  path: portableRepositoryChildPathSchema,
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});

const contextCoverageFields = {
  filesDiscovered: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  skippedFiles: z.array(portableRepositoryChildPathSchema),
};

const contextCoverageSchema = z
  .discriminatedUnion("parseStatus", [
    z.strictObject({...contextCoverageFields, parseStatus: z.literal("complete")}),
    z.strictObject({...contextCoverageFields, parseStatus: z.literal("partial"), reason: z.string().min(1)}),
    z.strictObject({...contextCoverageFields, parseStatus: z.literal("unavailable"), reason: z.string().min(1)}),
  ])
  .superRefine((coverage, context) => {
    if (coverage.filesIndexed > coverage.filesDiscovered)
      context.addIssue({
        code: "custom",
        path: ["filesIndexed"],
        message: "Context cannot index more files than it discovered.",
      });
    if (coverage.parseStatus === "complete" && coverage.filesIndexed !== coverage.filesDiscovered)
      context.addIssue({
        code: "custom",
        path: ["filesIndexed"],
        message: "Complete context coverage must index every discovered file.",
      });
    if (coverage.parseStatus === "complete" && coverage.skippedFiles.length > 0)
      context.addIssue({
        code: "custom",
        path: ["skippedFiles"],
        message: "Complete context coverage cannot list skipped files.",
      });
  });

const contextIndexSchema = z
  .strictObject({
    schemaVersion: version("footgun.context-index.v1"),
    tool: z.strictObject({name: z.string().min(1), version: z.string().min(1)}),
    files: z.array(portableRepositoryChildPathSchema),
    definitions: z.array(contextDefinitionSchema),
    references: z.array(contextReferenceSchema),
    calls: z.array(contextCallSchema),
    coverage: contextCoverageSchema,
    revision: z.string().nullable(),
    stale: z.boolean(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((index, context) => {
    const files = new Set(index.files);
    if (files.size !== index.files.length)
      context.addIssue({code: "custom", path: ["files"], message: "Context file paths must be unique."});
    if (index.coverage.filesIndexed !== index.files.length)
      context.addIssue({
        code: "custom",
        path: ["coverage", "filesIndexed"],
        message: "Context coverage filesIndexed must match the listed indexed files.",
      });
    const skipped = new Set(index.coverage.skippedFiles);
    if (skipped.size !== index.coverage.skippedFiles.length)
      context.addIssue({
        code: "custom",
        path: ["coverage", "skippedFiles"],
        message: "Context coverage skipped files must be unique.",
      });
    if (index.coverage.skippedFiles.some((path) => files.has(path)))
      context.addIssue({
        code: "custom",
        path: ["coverage", "skippedFiles"],
        message: "Context coverage cannot both index and skip a file.",
      });
    for (const [field, entries] of [
      ["definitions", index.definitions],
      ["references", index.references],
      ["calls", index.calls],
    ] as const)
      for (const [entryIndex, entry] of entries.entries())
        if (!files.has(entry.path))
          context.addIssue({
            code: "custom",
            path: [field, entryIndex, "path"],
            message: "Context entries must belong to a retained indexed file.",
          });
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
    filesModified: z.array(portableRepositoryChildPathSchema).length(0).default([]),
    rawArtifacts: z.array(rawArtifactSchema),
    rawArtifactDigests: z.record(rawArtifactSchema, z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  })
  .superRefine((report, context) => {
    requireUniqueFindingIds(report.findings, context);
    requireRetainedFindingRelations(report.findings, context);
    requireUniqueCoverageRecords(report.coverage, context);
    const rawArtifacts = requireUniqueStrings(report.rawArtifacts, context, "rawArtifacts");
    for (const artifact of Object.keys(report.rawArtifactDigests ?? {}))
      if (!rawArtifacts.has(artifact))
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
  command: commandSchema,
  tool: z.strictObject({name: z.string().min(1), version: z.string().min(1)}).optional(),
  languages: uniqueNonemptyStrings("Adapter languages must be unique.").default([]),
  capabilities: uniqueNonemptyStrings("Adapter capabilities must be unique."),
  inputKinds: uniqueNonemptyStrings("Adapter input kinds must be unique.").default([]),
  outputKinds: uniqueNonemptyStrings("Adapter output kinds must be unique.").default([]),
  requirements: uniqueNonemptyStrings("Adapter requirements must be unique.").default([]),
  sideEffects: z
    .array(z.enum(["read", "execute", "write", "network", "service", "resource"]))
    .refine((effects) => new Set(effects).size === effects.length, "Adapter side effects must be unique.")
    .default(["execute"]),
  determinism: z
    .enum(["deterministic", "seeded", "environment-sensitive", "nondeterministic"])
    .default("environment-sensitive"),
  probeCommand: commandSchema.optional(),
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
  targets: uniqueNonemptyStrings("Adapter targets must be unique.").default([]),
  revision: z.string().nullable().default(null),
  sourceDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  configDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  requestedCapabilities: uniqueNonemptyStrings("Requested adapter capabilities must be unique.").default([]),
  executionPolicy: z
    .strictObject({
      network: z.enum(["disabled", "explicit"]),
      shell: z.literal(false),
      maxOutputBytes: z.number().int().positive(),
    })
    .default({network: "disabled", shell: false, maxOutputBytes: 1_000_000}),
});

const adapterResultFields = {
  schemaVersion: version("footgun.adapter-result.v2"),
  requestId: z.string().min(1),
  findings: z.array(findingSchema),
  coverage: z.array(coverageSchema),
  rawArtifacts: z.array(rawArtifactSchema),
  rawArtifactDigests: z.record(rawArtifactSchema, z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  adapter: z
    .strictObject({
      id: z.string().min(1),
      version: z.string().min(1),
      command: commandSchema,
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
};

const adapterResultSchema = z
  .discriminatedUnion("state", [
    z.strictObject({
      ...adapterResultFields,
      state: z.literal("complete"),
      coverage: z.array(completeCoverageSchema),
      diagnostics: z.array(problemSchema),
    }),
    z.strictObject({...adapterResultFields, state: z.literal("partial"), diagnostics: z.array(problemSchema)}),
    z.strictObject({
      ...adapterResultFields,
      state: z.literal("unavailable"),
      diagnostics: z.array(problemSchema).min(1),
    }),
    z.strictObject({...adapterResultFields, state: z.literal("blocked"), diagnostics: z.array(problemSchema).min(1)}),
    z.strictObject({...adapterResultFields, state: z.literal("failed"), diagnostics: z.array(problemSchema).min(1)}),
    z.strictObject({...adapterResultFields, state: z.literal("cancelled"), diagnostics: z.array(problemSchema).min(1)}),
  ])
  .superRefine((result, context) => {
    requireUniqueFindingIds(result.findings, context);
    requireRetainedFindingRelations(result.findings, context);
    requireUniqueCoverageRecords(result.coverage, context);
    const rawArtifacts = requireUniqueStrings(result.rawArtifacts, context, "rawArtifacts");
    for (const artifact of Object.keys(result.rawArtifactDigests))
      if (!rawArtifacts.has(artifact))
        context.addIssue({
          code: "custom",
          message: "An artifact digest requires a matching rawArtifacts entry.",
          path: ["rawArtifactDigests", artifact],
        });
    if (
      result.state === "partial" &&
      result.diagnostics.length === 0 &&
      result.coverage.every((coverage) => coverage.parseStatus === "complete")
    )
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "A partial adapter result requires a diagnostic or incomplete coverage record.",
      });
  });

const workloadCommonFields = {
  schemaVersion: version("footgun.workload.v2"),
  command: commandSchema,
  cwd: repositoryRelativePathSchema,
  environment: z.record(z.string(), z.string()),
  inheritEnvironment: z.boolean(),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  datasetDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  statisticalPolicy: z
    .strictObject({
      kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
      minimumRelativeImprovement: z.number().nonnegative().max(1),
    })
    .default({kind: "median-improvement", minimumRelativeImprovement: 0}),
  expectedArtifacts: uniqueRepositoryChildPaths("Expected workload artifacts must be unique."),
  behaviorChecks: uniqueNonemptyStrings("Behavior checks must be unique."),
  networkPolicy: z.enum(["disabled", "explicit"]).default("disabled"),
};

const unavailableWorkloadFields = {
  resourceLimits: z.never().optional(),
  runner: z.never().optional(),
  candidateRoot: z.never().optional(),
};

const containerResourceLimitsSchema = z.strictObject({
  memoryBytes: z.number().int().positive().optional(),
  maxProcesses: z.number().int().positive().optional(),
});

const readOnlyWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  ...unavailableWorkloadFields,
  requestedProfile: z.literal("read-only"),
});

const localExecutionWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  ...unavailableWorkloadFields,
  requestedProfile: z.literal("local-exec"),
});

const serviceExecutionWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  ...unavailableWorkloadFields,
  requestedProfile: z.literal("service-exec"),
});

const candidateWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  ...unavailableWorkloadFields,
  requestedProfile: z.literal("candidate-write"),
  candidateRoot: repositoryChildPathSchema.optional(),
});

const dockerWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  candidateRoot: z.never().optional(),
  requestedProfile: z.literal("container-exec"),
  runner: z.strictObject({runtime: z.literal("docker"), image: z.string().min(1)}),
  resourceLimits: containerResourceLimitsSchema.optional(),
});

const podmanWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  candidateRoot: z.never().optional(),
  requestedProfile: z.literal("container-exec"),
  runner: z.strictObject({runtime: z.literal("podman"), image: z.string().min(1)}),
  resourceLimits: containerResourceLimitsSchema.optional(),
});

const bubblewrapWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  candidateRoot: z.never().optional(),
  resourceLimits: z.never().optional(),
  requestedProfile: z.literal("container-exec"),
  runner: z.strictObject({runtime: z.literal("bwrap")}),
});

const nsjailWorkloadSchema = z.strictObject({
  ...workloadCommonFields,
  candidateRoot: z.never().optional(),
  resourceLimits: z.never().optional(),
  requestedProfile: z.literal("container-exec"),
  runner: z.strictObject({runtime: z.literal("nsjail")}),
});

const workloadProfileSchemas = [
  readOnlyWorkloadSchema,
  localExecutionWorkloadSchema,
  serviceExecutionWorkloadSchema,
  candidateWorkloadSchema,
  dockerWorkloadSchema,
  podmanWorkloadSchema,
  bubblewrapWorkloadSchema,
  nsjailWorkloadSchema,
] as const;

const parameterSchema = z.strictObject({
  name: z.string().min(1),
  values: z
    .array(z.number().finite())
    .min(1)
    .refine((values) => new Set(values).size === values.length, "Scaling parameter values must be unique."),
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
    if (design.coordinates !== undefined) {
      const serializedCoordinates = design.coordinates.map(canonicalJson);
      if (new Set(serializedCoordinates).size !== serializedCoordinates.length)
        context.addIssue({
          code: "custom",
          message: "Scaling coordinates must be unique.",
          path: ["coordinates"],
        });
    }
  });

const unparameterizedWorkloadSchema = z.union(workloadProfileSchemas);
const singleScalingWorkloadSchema = z
  .union([
    readOnlyWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    localExecutionWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    serviceExecutionWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    candidateWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    dockerWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    podmanWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    bubblewrapWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
    nsjailWorkloadSchema.extend({inputSizeParameterization: singleParameterizationSchema}),
  ])
  .superRefine((workload, context) => {
    if (workload.inputSizeParameterization.commandIndex >= workload.command.length)
      context.addIssue({
        code: "custom",
        message: "The input-size command index must reference a declared command argument.",
        path: ["inputSizeParameterization", "commandIndex"],
      });
  });
const multiScalingWorkloadSchema = z
  .union([
    readOnlyWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    localExecutionWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    serviceExecutionWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    candidateWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    dockerWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    podmanWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    bubblewrapWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
    nsjailWorkloadSchema.extend({multiParameterization: multiParameterizationSchema}),
  ])
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
  command: commandSchema,
  cwd: repositoryRelativePathSchema,
  environmentKeys: uniqueNonemptyStrings("Reproduction environment keys must be unique."),
  timeoutMs: z.number().int().positive(),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  expectedArtifacts: uniqueRepositoryChildPaths("Reproduction expected artifacts must be unique."),
  datasetDigests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).default({}),
});

function uniqueNonemptyStrings(message: string): z.ZodArray<z.ZodString> {
  return z.array(z.string().min(1)).refine((values) => new Set(values).size === values.length, message);
}

const isolationCommonFields = {
  controlsRequested: uniqueNonemptyStrings("Requested isolation controls must be unique."),
  controlsApplied: uniqueNonemptyStrings("Applied isolation controls must be unique."),
  downgradeReasons: uniqueNonemptyStrings("Isolation downgrade reasons must be unique."),
};

const hostProcessIsolationSchema = z.strictObject({
  ...isolationCommonFields,
  backend: z.literal("host-process"),
  candidateWorkspace: z.never().optional(),
  runner: z.never().optional(),
});

const candidateWorkspaceIsolationSchema = z.strictObject({
  ...isolationCommonFields,
  controlsRequested: uniqueNonemptyStrings("Requested isolation controls must be unique.").refine(
    (controls) => controls.includes("candidate-workspace"),
    "Candidate measurements must request the candidate-workspace control.",
  ),
  backend: z.literal("host-process"),
  candidateWorkspace: portableRepositoryChildPathSchema,
  runner: z.never().optional(),
});

const dockerIsolationSchema = z.strictObject({
  ...isolationCommonFields,
  backend: z.literal("docker"),
  candidateWorkspace: z.never().optional(),
  runner: z.strictObject({runtime: z.literal("docker"), image: z.string().min(1)}),
});

const podmanIsolationSchema = z.strictObject({
  ...isolationCommonFields,
  backend: z.literal("podman"),
  candidateWorkspace: z.never().optional(),
  runner: z.strictObject({runtime: z.literal("podman"), image: z.string().min(1)}),
});

const bubblewrapIsolationSchema = z.strictObject({
  ...isolationCommonFields,
  backend: z.literal("bwrap"),
  candidateWorkspace: z.never().optional(),
  runner: z.strictObject({runtime: z.literal("bwrap")}),
});

const nsjailIsolationSchema = z.strictObject({
  ...isolationCommonFields,
  backend: z.literal("nsjail"),
  candidateWorkspace: z.never().optional(),
  runner: z.strictObject({runtime: z.literal("nsjail")}),
});

const containerIsolationSchema = z.union([
  dockerIsolationSchema,
  podmanIsolationSchema,
  bubblewrapIsolationSchema,
  nsjailIsolationSchema,
] as const);

const isolationSchema = z.union([
  hostProcessIsolationSchema,
  candidateWorkspaceIsolationSchema,
  ...containerIsolationSchema.options,
] as const);

const behaviorCheckFields = {
  check: z.string().min(1),
  passed: z.boolean(),
  observed: z.string().optional(),
};

const behaviorCheckSchema = z.strictObject(behaviorCheckFields);
const passedBehaviorCheckSchema = z.strictObject({...behaviorCheckFields, passed: z.literal(true)});

const measurementBaseFields = {
  schemaVersion: version("footgun.measurement.v1"),
  id: z.string().regex(/^meas_[a-f0-9]{16}$/),
  investigation: z.string().optional(),
  workloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  samplesMs: z.array(z.number().finite().nonnegative()).min(1),
  warmups: z.number().int().nonnegative(),
  repetitions: z.number().int().positive(),
  medianMs: z.number().finite().nonnegative(),
  meanMs: z.number().finite().nonnegative(),
  quartiles: z.strictObject({q1Ms: z.number().finite().nonnegative(), q3Ms: z.number().finite().nonnegative()}),
  statisticalPolicy: z.strictObject({
    kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
    minimumRelativeImprovement: z.number().nonnegative().max(1),
  }),
  reproduction: reproductionSchema,
  environment: z.strictObject({node: z.string(), platform: z.string(), arch: z.string()}),
  artifact: z.string().min(1).optional(),
};

const localMeasurementSchema = z.strictObject({
  ...measurementBaseFields,
  executionProfile: z.literal("local-exec"),
  isolation: hostProcessIsolationSchema,
});

const candidateMeasurementSchema = z.strictObject({
  ...measurementBaseFields,
  executionProfile: z.literal("candidate-write"),
  isolation: candidateWorkspaceIsolationSchema,
});

const containerMeasurementSchema = z.strictObject({
  ...measurementBaseFields,
  executionProfile: z.literal("container-exec"),
  isolation: containerIsolationSchema,
});

const behaviorValidatedMeasurementSchema = z.union([
  localMeasurementSchema.extend({
    behaviorValidated: z.literal(true),
    behaviorChecks: z.array(passedBehaviorCheckSchema).min(1),
  }),
  candidateMeasurementSchema.extend({
    behaviorValidated: z.literal(true),
    behaviorChecks: z.array(passedBehaviorCheckSchema).min(1),
  }),
  containerMeasurementSchema.extend({
    behaviorValidated: z.literal(true),
    behaviorChecks: z.array(passedBehaviorCheckSchema).min(1),
  }),
] as const);

const behaviorUnvalidatedMeasurementSchema = z.union([
  localMeasurementSchema.extend({
    behaviorValidated: z.literal(false),
    behaviorChecks: z.array(behaviorCheckSchema).optional(),
  }),
  candidateMeasurementSchema.extend({
    behaviorValidated: z.literal(false),
    behaviorChecks: z.array(behaviorCheckSchema).optional(),
  }),
  containerMeasurementSchema.extend({
    behaviorValidated: z.literal(false),
    behaviorChecks: z.array(behaviorCheckSchema).optional(),
  }),
] as const);

const measurementSchema = z
  .union([behaviorValidatedMeasurementSchema, behaviorUnvalidatedMeasurementSchema] as const)
  .superRefine((measurement, context) => {
    if (measurement.samplesMs.length !== measurement.repetitions)
      context.addIssue({
        code: "custom",
        path: ["samplesMs"],
        message: "Measurements must record exactly one sample for every repetition.",
      });
    if (
      measurement.reproduction.warmups !== measurement.warmups ||
      measurement.reproduction.repetitions !== measurement.repetitions
    )
      context.addIssue({
        code: "custom",
        path: ["reproduction"],
        message: "The reproduction contract must preserve the measurement warmup and repetition counts.",
      });
    const sorted = [...measurement.samplesMs].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
    const meanMs = measurement.samplesMs.reduce((sum, sample) => sum + sample, 0) / measurement.samplesMs.length;
    const q1Ms = quantile(sorted, 0.25);
    const q3Ms = quantile(sorted, 0.75);
    if (measurement.medianMs !== medianMs)
      context.addIssue({code: "custom", path: ["medianMs"], message: "Median must match the recorded samples."});
    if (measurement.meanMs !== meanMs)
      context.addIssue({code: "custom", path: ["meanMs"], message: "Mean must match the recorded samples."});
    if (measurement.quartiles.q1Ms !== q1Ms || measurement.quartiles.q3Ms !== q3Ms)
      context.addIssue({code: "custom", path: ["quartiles"], message: "Quartiles must match the recorded samples."});
  });

function quantile(sorted: ReadonlyArray<number>, fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

const benchmarkRecordFields = {
  schemaVersion: version("footgun.benchmark-record.v2"),
  id: z.string().regex(/^bench_[a-f0-9]{16}$/),
  tool: z.enum(["hyperfine", "pyperf", "google-benchmark", "criterion", "jmh"]),
  name: z.string().min(1),
  samplesMs: z.array(z.number().finite().nonnegative()).min(1),
  medianMs: z.number().finite().nonnegative(),
  meanMs: z.number().finite().nonnegative(),
  sourceUnit: z.string().min(1),
  metadata: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).default({}),
};

const rawArtifactFields = {
  rawArtifact: rawArtifactSchema,
  rawArtifactDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};

const noRawArtifactFields = {
  rawArtifact: z.never().optional(),
  rawArtifactDigest: z.never().optional(),
};

const benchmarkRecordSchema = z
  .union([
    z.strictObject({...benchmarkRecordFields, ...rawArtifactFields}),
    z.strictObject({...benchmarkRecordFields, ...noRawArtifactFields}),
  ])
  .superRefine((record, context) => {
    const sorted = [...record.samplesMs].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
    const mean = record.samplesMs.reduce((sum, sample) => sum + sample, 0) / record.samplesMs.length;
    if (record.medianMs !== median || record.meanMs !== mean)
      context.addIssue({code: "custom", message: "Benchmark summaries must match the recorded samples."});
  });

const benchmarkImportFields = {
  schemaVersion: version("footgun.benchmark-import.v2"),
  tool: benchmarkRecordFields.tool,
  records: z.array(benchmarkRecordSchema).min(1),
};

const benchmarkImportSchema = z
  .union([
    z.strictObject({...benchmarkImportFields, ...rawArtifactFields}),
    z.strictObject({...benchmarkImportFields, ...noRawArtifactFields}),
  ])
  .superRefine((benchmarkImport, context) => {
    const ids = new Set<string>();
    const hasRawArtifact = "rawArtifact" in benchmarkImport;
    for (const [index, record] of benchmarkImport.records.entries()) {
      if (ids.has(record.id))
        context.addIssue({
          code: "custom",
          path: ["records", index, "id"],
          message: "Benchmark record IDs must be unique.",
        });
      ids.add(record.id);
      if (record.tool !== benchmarkImport.tool)
        context.addIssue({
          code: "custom",
          path: ["records", index, "tool"],
          message: "Every benchmark record must use the import's declared tool.",
        });
      const recordHasRawArtifact = "rawArtifact" in record;
      if (
        recordHasRawArtifact !== hasRawArtifact ||
        (recordHasRawArtifact && record.rawArtifact !== benchmarkImport.rawArtifact)
      )
        context.addIssue({
          code: "custom",
          path: ["records", index, "rawArtifact"],
          message: "Every benchmark record must share the import's raw artifact provenance.",
        });
      if (recordHasRawArtifact && hasRawArtifact && record.rawArtifactDigest !== benchmarkImport.rawArtifactDigest)
        context.addIssue({
          code: "custom",
          path: ["records", index, "rawArtifactDigest"],
          message: "Every benchmark record must share the import's raw artifact digest.",
        });
    }
  });

const profileSummarySchema = z
  .strictObject({
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
  })
  .superRefine((profile, context) => {
    if (profile.id !== `prof_${profile.sourceDigest.slice(0, 16)}`)
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Profile summary ID must be derived from its source digest.",
      });
  });

const traceSummarySchema = z
  .strictObject({
    schemaVersion: version("footgun.trace-summary.v1"),
    id: z.string().regex(/^trace_[a-f0-9]{16}$/),
    tool: z.literal("perfetto"),
    sourceArtifact: z.string().min(1),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    query: z.string().min(1).optional(),
    columns: z.array(z.string().min(1)),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))),
    limitations: z.array(z.string()),
  })
  .superRefine((summary, context) => {
    const columns = new Set(summary.columns);
    if (columns.size !== summary.columns.length)
      context.addIssue({code: "custom", message: "Trace summary columns must be unique."});
    for (const [rowIndex, row] of summary.rows.entries())
      for (const name of Object.keys(row))
        if (!columns.has(name))
          context.addIssue({
            code: "custom",
            path: ["rows", rowIndex, name],
            message: "Every trace row field must be declared by columns.",
          });
    if (summary.id !== `trace_${summary.sourceDigest.slice(0, 16)}`)
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Trace summary ID must be derived from its source digest.",
      });
  });

const scalingPointFields = {
  value: z.number().finite(),
  statisticalPolicy: z.strictObject({
    kind: z.enum(["median-improvement", "non-overlapping-iqr"]),
    minimumRelativeImprovement: z.number().nonnegative().max(1),
  }),
  behaviorValidated: z.boolean(),
  isolation: isolationSchema.optional(),
  diagnostic: z.string().optional(),
};

const completedScalingPointSchema = z.strictObject({
  ...scalingPointFields,
  status: z.literal("complete"),
  samplesMs: z.array(z.number().finite().nonnegative()).min(1),
  medianMs: z.number().finite().nonnegative(),
  meanMs: z.number().finite().nonnegative(),
  quartiles: z.strictObject({q1Ms: z.number().finite().nonnegative(), q3Ms: z.number().finite().nonnegative()}),
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

const scalingSchema = z
  .strictObject({
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
    artifact: z.string().min(1).optional(),
  })
  .superRefine((analysis, context) => {
    if (new Set(analysis.points.map((point) => point.value)).size !== analysis.points.length)
      context.addIssue({code: "custom", message: "Scaling point values must be unique.", path: ["points"]});
    const modelNames = new Set(analysis.models.map((model) => model.name));
    if (modelNames.size !== analysis.models.length)
      context.addIssue({code: "custom", message: "Scaling model names must be unique.", path: ["models"]});
    if (analysis.selectedModel !== undefined && !modelNames.has(analysis.selectedModel))
      context.addIssue({
        code: "custom",
        message: "selectedModel must name an included scaling model.",
        path: ["selectedModel"],
      });
    validateCompletedScalingPoints(analysis.points, analysis.reproduction.repetitions, context);
  });

const multiScalingPointSchema = z.discriminatedUnion("status", [
  completedScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
  timedOutScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
  failedScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
  cancelledScalingPointSchema.extend({coordinates: z.record(z.string(), z.number().finite())}),
]);

const multiScalingSchema = z
  .strictObject({
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
    artifact: z.string().min(1).optional(),
  })
  .superRefine((analysis, context) => {
    if (new Set(analysis.parameters).size !== analysis.parameters.length)
      context.addIssue({code: "custom", message: "Scaling parameter names must be distinct.", path: ["parameters"]});
    for (const [index, point] of analysis.points.entries()) {
      const coordinateNames = Object.keys(point.coordinates);
      if (
        coordinateNames.length !== analysis.parameters.length ||
        !analysis.parameters.every((parameter) => Object.hasOwn(point.coordinates, parameter))
      )
        context.addIssue({
          code: "custom",
          message: "Every scaling point must contain exactly the declared parameter names.",
          path: ["points", index, "coordinates"],
        });
    }
    const serializedCoordinates = analysis.points.map((point) => canonicalJson(point.coordinates));
    if (new Set(serializedCoordinates).size !== serializedCoordinates.length)
      context.addIssue({
        code: "custom",
        message: "Scaling point coordinates must be unique.",
        path: ["points"],
      });
    const digest = createHash("sha256")
      .update(canonicalJson(analysis.points.map((point) => point.coordinates)))
      .digest("hex");
    if (digest !== analysis.coordinatesDigest)
      context.addIssue({
        code: "custom",
        message: "coordinatesDigest must match the ordered scaling point coordinates.",
        path: ["coordinatesDigest"],
      });
    validateCompletedScalingPoints(analysis.points, analysis.reproduction.repetitions, context);
  });

function validateCompletedScalingPoints(
  points: ReadonlyArray<{
    readonly status: string;
    readonly samplesMs: ReadonlyArray<number>;
    readonly medianMs: number;
    readonly meanMs: number;
    readonly quartiles: {readonly q1Ms: number; readonly q3Ms: number};
  }>,
  repetitions: number,
  context: z.RefinementCtx,
): void {
  for (const [index, point] of points.entries()) {
    if (point.status !== "complete") continue;
    if (point.samplesMs.length !== repetitions)
      context.addIssue({
        code: "custom",
        path: ["points", index, "samplesMs"],
        message: "Completed scaling points must record one sample for every repetition.",
      });
    const sorted = [...point.samplesMs].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
    const mean = point.samplesMs.reduce((sum, sample) => sum + sample, 0) / point.samplesMs.length;
    if (
      point.medianMs !== median ||
      point.meanMs !== mean ||
      point.quartiles.q1Ms !== quantile(sorted, 0.25) ||
      point.quartiles.q3Ms !== quantile(sorted, 0.75)
    )
      context.addIssue({
        code: "custom",
        path: ["points", index],
        message: "Completed scaling point summaries must match their samples.",
      });
  }
}

const measurementArtifactSchema = z.union([measurementSchema, scalingSchema, multiScalingSchema]);

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

const comparabilitySchema = z.discriminatedUnion("status", [
  z.strictObject({status: z.literal("comparable"), reasons: z.array(z.string()).length(0)}),
  z.strictObject({status: z.literal("cross-machine"), reasons: z.array(z.string().min(1)).min(1)}),
  z.strictObject({status: z.literal("inconclusive"), reasons: z.array(z.string().min(1)).min(1)}),
]);

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
  comparability: comparabilitySchema.optional(),
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

const comparisonSchema = z
  .union([
    z.discriminatedUnion("mode", [measurementComparisonSchema, scalingComparisonSchema]),
    z.discriminatedUnion("mode", [measurementComparisonWithDigestsSchema, scalingComparisonWithDigestsSchema]),
  ])
  .superRefine((comparison, context) => {
    if (comparison.mode === "measurement") {
      const expectedDelta =
        comparison.baselineMedianMs === 0
          ? 0
          : ((comparison.candidateMedianMs - comparison.baselineMedianMs) / comparison.baselineMedianMs) * 100;
      if (comparison.deltaPercent !== expectedDelta)
        context.addIssue({
          code: "custom",
          path: ["deltaPercent"],
          message: "Comparison deltaPercent must match the declared median measurements.",
        });
    } else {
      for (const [index, point] of comparison.points.entries()) {
        const expectedDelta =
          point.baselineMedianMs === 0
            ? 0
            : ((point.candidateMedianMs - point.baselineMedianMs) / point.baselineMedianMs) * 100;
        if (point.deltaPercent !== expectedDelta)
          context.addIssue({
            code: "custom",
            path: ["points", index, "deltaPercent"],
            message: "Scaling comparison point deltaPercent must match its median measurements.",
          });
        if (
          point.statisticalPolicy.kind !== comparison.statisticalPolicy.kind ||
          point.statisticalPolicy.minimumRelativeImprovement !== comparison.statisticalPolicy.minimumRelativeImprovement
        )
          context.addIssue({
            code: "custom",
            path: ["points", index, "statisticalPolicy"],
            message: "Scaling comparison points must share the comparison statistical policy.",
          });
      }
      if (comparison.improvement !== comparison.points.every((point) => point.improvement))
        context.addIssue({
          code: "custom",
          path: ["improvement"],
          message: "Scaling comparison improvement must require every point to improve.",
        });
    }
    const comparability = comparison.comparability;
    if (comparison.promotion === undefined) {
      if (comparison.promotionReasons !== undefined)
        context.addIssue({
          code: "custom",
          path: ["promotionReasons"],
          message: "Promotion reasons require a declared promotion status.",
        });
      return;
    }
    const reasons = comparison.promotionReasons;
    if (reasons === undefined) {
      context.addIssue({
        code: "custom",
        path: ["promotionReasons"],
        message: "A declared promotion status requires promotion reasons.",
      });
      return;
    }
    if (comparison.promotion === "eligible") {
      if (
        !comparison.behaviorValidated ||
        !comparison.improvement ||
        comparability?.status !== "comparable" ||
        reasons.length > 0
      )
        context.addIssue({
          code: "custom",
          path: ["promotion"],
          message:
            "Eligible promotion requires validated behavior, improvement, comparable environments, and no blockers.",
        });
    } else if (reasons.length === 0)
      context.addIssue({
        code: "custom",
        path: ["promotionReasons"],
        message: "A non-eligible promotion status requires at least one reason.",
      });
  });

const investigationStates = [
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
] as const;

type InvestigationState = (typeof investigationStates)[number];
type InvestigationArtifactRequirement = "empty" | "retained" | "any";

const investigationCommonFields = {
  schemaVersion: version("footgun.investigation-bundle.v2"),
  id: z.string().regex(/^inv_[a-f0-9]{16}$/),
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
  diagnostics: z.array(problemSchema),
};

function investigationStateSchema<const State extends InvestigationState>(
  state: State,
  artifactRequirement: InvestigationArtifactRequirement,
) {
  const reports = z.array(z.string().min(1));
  const evidence = z.array(evidenceSchema);
  const artifacts =
    artifactRequirement === "empty"
      ? {reports: reports.max(0), evidence: evidence.max(0)}
      : artifactRequirement === "retained"
        ? {reports: reports.min(1), evidence: evidence.min(1)}
        : {reports, evidence};
  return z.strictObject({...investigationCommonFields, state: z.literal(state), ...artifacts});
}

const investigationSchema = z
  .union([
    investigationStateSchema("created", "empty"),
    investigationStateSchema("inventoried", "empty"),
    investigationStateSchema("scanned", "retained"),
    investigationStateSchema("context-resolved", "retained"),
    investigationStateSchema("measurement-planned", "any"),
    investigationStateSchema("baseline-measured", "retained"),
    investigationStateSchema("candidate-compared", "retained"),
    investigationStateSchema("behavior-validated", "retained"),
    investigationStateSchema("reported", "retained"),
    investigationStateSchema("blocked", "any"),
    investigationStateSchema("inconclusive", "any"),
    investigationStateSchema("unavailable", "any"),
    investigationStateSchema("cancelled", "any"),
    investigationStateSchema("failed", "any"),
  ])
  .superRefine((bundle, context) => {
    const unique = (values: ReadonlyArray<string>, path: string, message: string): void => {
      if (new Set(values).size !== values.length) context.addIssue({code: "custom", path: [path], message});
    };
    const hasRetainedEvidence = (matches: (record: EvidenceRecordV2) => boolean): boolean =>
      bundle.evidence.some(
        (record) => matches(record) && record.artifact !== undefined && bundle.reports.includes(record.artifact),
      );
    if (bundle.findingIds !== undefined) unique(bundle.findingIds, "findingIds", "Finding IDs must be unique.");
    unique(bundle.reports, "reports", "Investigation report references must be unique.");
    unique(
      bundle.evidence.map((record) => record.id),
      "evidence",
      "Investigation evidence IDs must be unique.",
    );
    if (bundle.state === "baseline-measured" && !hasRetainedEvidence((record) => record.kind === "measurement"))
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A baseline-measured investigation requires retained measurement evidence.",
      });
    if (bundle.state === "context-resolved" && !hasRetainedEvidence((record) => record.kind === "context"))
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A context-resolved investigation requires retained context evidence.",
      });
    if (bundle.state === "scanned" && !hasRetainedEvidence((record) => record.kind === "static"))
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A scanned investigation requires retained static scan evidence.",
      });
    if (
      (bundle.state === "candidate-compared" || bundle.state === "behavior-validated") &&
      !hasRetainedEvidence((record) => record.kind === "behavior" && record.claimClass === "behavioral")
    )
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: `Investigation state ${bundle.state} requires retained behavioral comparison evidence.`,
      });
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
export type UnparameterizedWorkloadV2 = z.infer<typeof unparameterizedWorkloadSchema>;
export type SingleScalingWorkloadV2 = z.infer<typeof singleScalingWorkloadSchema>;
export type MultiScalingWorkloadV2 = z.infer<typeof multiScalingWorkloadSchema>;
export type ParsedWorkloadV2 =
  | {readonly kind: "unparameterized"; readonly workload: UnparameterizedWorkloadV2}
  | {readonly kind: "single-scaling"; readonly workload: SingleScalingWorkloadV2}
  | {readonly kind: "multi-scaling"; readonly workload: MultiScalingWorkloadV2};
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
export type MeasurementArtifactV1 = z.infer<typeof measurementArtifactSchema>;
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

/** Classify one parsed workload exactly once at its execution boundary. */
export function classifyWorkload(workload: WorkloadV2): ParsedWorkloadV2 {
  if (isMultiScalingWorkload(workload)) return {kind: "multi-scaling", workload};
  if (isSingleScalingWorkload(workload)) return {kind: "single-scaling", workload};
  return {kind: "unparameterized", workload};
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
  measurementArtifact: measurementArtifactSchema,
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
