import {createHash} from "node:crypto";
import {realpath, stat} from "node:fs/promises";
import {homedir} from "node:os";
import {basename, dirname, isAbsolute, join, resolve} from "node:path";
import {z} from "zod";
import type {ProblemV1} from "./protocol/index.js";
import {readBoundedUtf8File} from "./files.js";
import {comparePortable, isWithinRoot} from "./paths.js";
import {stableJson} from "./serialization.js";

const outputFormats = ["human", "json", "markdown", "sarif"] as const;
const maxConfigBytes = 1024 * 1024;
export type OutputFormat = (typeof outputFormats)[number];

const fileConfigSchema = z.strictObject({
  cwd: z.string().min(1).optional(),
  format: z.enum(outputFormats).optional(),
  output: z.string().min(1).optional(),
  noColor: z.boolean().optional(),
  quiet: z.boolean().optional(),
  debug: z.boolean().optional(),
  nonInteractive: z.boolean().optional(),
  strict: z.boolean().optional(),
  failOn: z.string().min(1).optional(),
  exclude: z.array(z.string().min(1)).optional(),
  adapters: z.array(z.string().min(1)).optional(),
  maxFindings: z.number().int().positive().optional(),
});

type FileConfig = z.infer<typeof fileConfigSchema>;

export type CliOverrides = Readonly<{
  readonly cwd?: string;
  readonly config?: string;
  readonly format?: OutputFormat;
  readonly output?: string;
  readonly noColor?: boolean;
  readonly quiet?: boolean;
  readonly debug?: boolean;
  readonly nonInteractive?: boolean;
  readonly strict?: boolean;
  readonly failOn?: string;
  readonly exclude?: ReadonlyArray<string>;
  readonly adapters?: ReadonlyArray<string>;
  readonly maxFindings?: number;
}>;

export type RuntimeConfig = {
  readonly cwd: string;
  readonly format: OutputFormat;
  readonly output: string | undefined;
  readonly noColor: boolean;
  readonly quiet: boolean;
  readonly debug: boolean;
  readonly nonInteractive: boolean;
  readonly strict: boolean;
  readonly failOn: string | undefined;
  readonly exclude: ReadonlyArray<string>;
  readonly adapters: ReadonlyArray<string>;
  readonly maxFindings: number;
  readonly source: string;
  readonly digest: string;
};

export type ConfigFailure = ProblemV1 & {_tag: "ConfigFailure"};

type ConfigLocation = {readonly path: string; readonly scope: "project" | "user"};

const defaults: FileConfig = {
  format: "human",
  noColor: false,
  quiet: false,
  debug: false,
  nonInteractive: false,
  strict: false,
  failOn: undefined,
  exclude: [],
  adapters: [],
  maxFindings: 80,
};

/** Load JSON configuration using CLI > environment > file > defaults precedence. */
export async function loadConfig(
  overrides: CliOverrides,
  environment: NodeJS.ProcessEnv = process.env,
  invocationCwd: string = process.cwd(),
): Promise<RuntimeConfig | ConfigFailure> {
  const cwdInput = overrides.cwd ?? environment.SMOKINGGUN_CWD ?? invocationCwd;
  const initialCwd = resolve(cwdInput);
  const explicitPath = overrides.config ?? environment.SMOKINGGUN_CONFIG;
  let configScope: ConfigLocation["scope"] | "explicit" | undefined;
  let configPath: string | undefined;
  try {
    if (explicitPath === undefined) {
      const discovered = await findNearestConfig(initialCwd, environment);
      configPath = discovered?.path;
      configScope = discovered?.scope;
    } else {
      configPath = resolve(initialCwd, explicitPath);
      configScope = "explicit";
    }
  } catch (cause: unknown) {
    return configFailure(
      "config-discovery-failed",
      "Could not inspect configuration locations.",
      cause instanceof Error ? cause.message : "Unknown configuration discovery failure.",
    );
  }
  let fileValues: FileConfig = {};
  let source = "built-in defaults";
  if (configPath !== undefined) {
    const parsed = await readJsonConfig(configPath);
    if (parsed._tag === "ConfigFailure") return parsed;
    fileValues = parsed.value;
    source = configPath;
  }

  const envValues = parseEnvironment(environment);
  if ("_tag" in envValues) return envValues;
  const fileCwd =
    fileValues.cwd === undefined
      ? initialCwd
      : resolve(configPath === undefined ? initialCwd : dirname(configPath), fileValues.cwd);
  const selectedCwd = overrides.cwd === undefined && environment.SMOKINGGUN_CWD === undefined ? fileCwd : initialCwd;
  const merged: FileConfig = {
    ...defaults,
    ...fileValues,
    ...envValues,
    ...stripConfigMeta(overrides),
    cwd: selectedCwd,
  };
  const cwd = resolve(merged.cwd ?? initialCwd);
  const outputBase =
    overrides.output !== undefined || environment.SMOKINGGUN_OUTPUT !== undefined
      ? initialCwd
      : configPath === undefined
        ? initialCwd
        : dirname(configPath);
  const resolvedOutput = merged.output === undefined ? undefined : resolve(outputBase, merged.output);
  const resolvedAdapters = resolveAdapterPaths(
    merged.adapters ?? [],
    configPath === undefined ? initialCwd : dirname(configPath),
  );

  // Validate auto-discovered config paths to prevent traversal attacks (#73)
  if (configPath !== undefined && configScope === "project") {
    const configRoot = await canonicalProspectivePath(dirname(configPath));
    const canonicalCwd = await canonicalProspectivePath(cwd);
    if (fileValues.cwd !== undefined && !isWithinRoot(configRoot, canonicalCwd)) {
      return configFailure(
        "config-path-traversal",
        "Auto-discovered configuration sets a working directory outside its project root.",
        `cwd resolves to ${cwd}, which escapes ${configRoot}. Use --cwd to override explicitly.`,
      );
    }
    if (resolvedOutput !== undefined && !isWithinRoot(configRoot, await canonicalProspectivePath(resolvedOutput))) {
      return configFailure(
        "config-path-traversal",
        "Auto-discovered configuration sets an output path outside its project root.",
        `output resolves to ${resolvedOutput}, which escapes ${configRoot}. Use --output to override explicitly.`,
      );
    }
    for (const adapterPath of resolvedAdapters) {
      if (!isWithinRoot(configRoot, await canonicalProspectivePath(adapterPath))) {
        return configFailure(
          "config-path-traversal",
          "Auto-discovered configuration references an adapter outside its project root.",
          `adapter ${adapterPath} escapes ${configRoot}. Use --adapter to override explicitly.`,
        );
      }
    }
  }

  const normalized: RuntimeConfig = {
    cwd,
    format: merged.format ?? "human",
    output: resolvedOutput,
    noColor: merged.noColor ?? false,
    quiet: merged.quiet ?? false,
    debug: merged.debug ?? false,
    nonInteractive: merged.nonInteractive ?? false,
    strict: merged.strict ?? false,
    failOn: merged.failOn,
    exclude: uniqueSorted(merged.exclude ?? []),
    adapters: resolvedAdapters,
    maxFindings: merged.maxFindings ?? 80,
    source,
    digest: digestConfig({
      cwd,
      format: merged.format ?? "human",
      noColor: merged.noColor ?? false,
      quiet: merged.quiet ?? false,
      debug: merged.debug ?? false,
      nonInteractive: merged.nonInteractive ?? false,
      strict: merged.strict ?? false,
      failOn: merged.failOn,
      exclude: uniqueSorted(merged.exclude ?? []),
      adapters: resolvedAdapters,
      maxFindings: merged.maxFindings ?? 80,
    }),
  };
  return normalized;
}

async function canonicalProspectivePath(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let existing = resolve(path);
  while (true) {
    try {
      const canonical = await realpath(existing);
      return resolve(canonical, ...missingSegments.reverse());
    } catch (cause: unknown) {
      if (!isErrno(cause, "ENOENT")) throw cause;
      const parent = dirname(existing);
      if (parent === existing) throw cause;
      missingSegments.push(basename(existing));
      existing = parent;
    }
  }
}

async function readJsonConfig(
  path: string,
): Promise<{readonly _tag: "ok"; readonly value: FileConfig} | ConfigFailure> {
  try {
    const raw = await readBoundedUtf8File(path, maxConfigBytes);
    const parsed: unknown = JSON.parse(raw);
    const result = fileConfigSchema.safeParse(parsed);
    if (!result.success) {
      return configFailure(
        "invalid-config",
        `Configuration at ${path} is invalid.`,
        result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    return {_tag: "ok", value: result.data};
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "unknown read failure";
    return configFailure("config-read-failed", `Could not read configuration at ${path}.`, detail);
  }
}

async function findNearestConfig(start: string, environment: NodeJS.ProcessEnv): Promise<ConfigLocation | undefined> {
  let current = start;
  while (true) {
    const candidate = join(current, "smokinggun.config.json");
    try {
      await readFile(candidate, "utf8");
      return {path: candidate, scope: "project"};
    } catch (cause: unknown) {
      if (!isErrno(cause, "ENOENT")) throw cause;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const userConfig = join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "smokinggun", "config.json");
  try {
    await readFile(userConfig, "utf8");
    return {path: userConfig, scope: "user"};
  } catch (cause: unknown) {
    if (!isErrno(cause, "ENOENT")) throw cause;
    return undefined;
  }
}

function parseEnvironment(environment: NodeJS.ProcessEnv): FileConfig | ConfigFailure {
  const values: FileConfig = {};
  if (environment.SMOKINGGUN_FORMAT !== undefined) {
    if (!isOutputFormat(environment.SMOKINGGUN_FORMAT))
      return configFailure(
        "invalid-environment",
        "SMOKINGGUN_FORMAT is invalid.",
        "Expected one of " + outputFormats.join(", ") + ".",
      );
    values.format = environment.SMOKINGGUN_FORMAT;
  }
  if (environment.SMOKINGGUN_OUTPUT !== undefined) values.output = environment.SMOKINGGUN_OUTPUT;
  if (environment.SMOKINGGUN_FAIL_ON !== undefined) values.failOn = environment.SMOKINGGUN_FAIL_ON;
  for (const [name, key] of [
    ["SMOKINGGUN_NO_COLOR", "noColor"],
    ["SMOKINGGUN_QUIET", "quiet"],
    ["SMOKINGGUN_DEBUG", "debug"],
    ["SMOKINGGUN_NON_INTERACTIVE", "nonInteractive"],
    ["SMOKINGGUN_STRICT", "strict"],
  ] as const) {
    const value = environment[name];
    if (value !== undefined) {
      if (value !== "true" && value !== "false")
        return configFailure("invalid-environment", `${name} is invalid.`, "Use the literal string true or false.");
      values[key] = value === "true";
    }
  }
  if (environment.SMOKINGGUN_MAX_FINDINGS !== undefined) {
    const value = Number(environment.SMOKINGGUN_MAX_FINDINGS);
    if (!Number.isInteger(value) || value <= 0)
      return configFailure("invalid-environment", "SMOKINGGUN_MAX_FINDINGS is invalid.", "Use a positive integer.");
    values.maxFindings = value;
  }
  if (environment.SMOKINGGUN_EXCLUDE !== undefined)
    values.exclude = environment.SMOKINGGUN_EXCLUDE.split(",").filter((value) => value.length > 0);
  if (environment.SMOKINGGUN_ADAPTERS !== undefined)
    values.adapters = environment.SMOKINGGUN_ADAPTERS.split(",").filter((value) => value.length > 0);
  return values;
}

function stripConfigMeta(overrides: CliOverrides): FileConfig {
  const values: FileConfig = {};
  if (overrides.cwd !== undefined) values.cwd = overrides.cwd;
  if (overrides.format !== undefined) values.format = overrides.format;
  if (overrides.output !== undefined) values.output = overrides.output;
  if (overrides.noColor !== undefined) values.noColor = overrides.noColor;
  if (overrides.quiet !== undefined) values.quiet = overrides.quiet;
  if (overrides.debug !== undefined) values.debug = overrides.debug;
  if (overrides.nonInteractive !== undefined) values.nonInteractive = overrides.nonInteractive;
  if (overrides.strict !== undefined) values.strict = overrides.strict;
  if (overrides.failOn !== undefined) values.failOn = overrides.failOn;
  if (overrides.exclude !== undefined) values.exclude = [...overrides.exclude];
  if (overrides.adapters !== undefined) values.adapters = [...overrides.adapters];
  if (overrides.maxFindings !== undefined) values.maxFindings = overrides.maxFindings;
  return values;
}

function uniqueSorted(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)].sort(comparePortable);
}

function resolveAdapterPaths(values: ReadonlyArray<string>, base: string): string[] {
  return uniqueSorted(values.map((value) => resolve(base, value)));
}

function digestConfig(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isOutputFormat(value: string): value is OutputFormat {
  return outputFormats.some((format) => format === value);
}

function configFailure(code: string, message: string, detail: string): ConfigFailure {
  return {
    _tag: "ConfigFailure",
    schemaVersion: "smokinggun.problem.v1",
    code,
    message,
    detail,
    recovery: "Fix the JSON configuration or pass a valid --config path.",
  };
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

export function isConfigFailure(value: RuntimeConfig | ConfigFailure): value is ConfigFailure {
  return "_tag" in value;
}

export function userDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.SMOKINGGUN_DATA_DIR ??
    resolve(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "smokinggun")
  );
}

export function resolveConfiguredPath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}
