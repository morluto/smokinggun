import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {z} from "zod";
import type {ProblemV1} from "./protocol/index.js";
import {comparePortable} from "./paths.js";
import {stableJson} from "./serialization.js";

const outputFormats = ["human", "json", "markdown", "sarif"] as const;
export type OutputFormat = (typeof outputFormats)[number];

const fileConfigSchema = z.strictObject({
  cwd: z.string().optional(),
  format: z.enum(outputFormats).optional(),
  output: z.string().optional(),
  noColor: z.boolean().optional(),
  quiet: z.boolean().optional(),
  debug: z.boolean().optional(),
  nonInteractive: z.boolean().optional(),
  strict: z.boolean().optional(),
  failOn: z.string().min(1).optional(),
  exclude: z.array(z.string()).optional(),
  adapters: z.array(z.string()).optional(),
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
): Promise<RuntimeConfig | ConfigFailure> {
  const cwdInput = overrides.cwd ?? environment.FOOTGUN_CWD ?? process.cwd();
  const initialCwd = resolve(cwdInput);
  const explicitPath = overrides.config ?? environment.FOOTGUN_CONFIG;
  let configPath: string | undefined;
  try {
    configPath =
      explicitPath === undefined ? await findNearestConfig(initialCwd, environment) : resolve(initialCwd, explicitPath);
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
  const selectedCwd = overrides.cwd === undefined && environment.FOOTGUN_CWD === undefined ? fileCwd : initialCwd;
  const merged: FileConfig = {
    ...defaults,
    ...fileValues,
    ...envValues,
    ...stripConfigMeta(overrides),
    cwd: selectedCwd,
  };
  const cwd = resolve(merged.cwd ?? initialCwd);
  const outputBase =
    overrides.output !== undefined || environment.FOOTGUN_OUTPUT !== undefined
      ? initialCwd
      : configPath === undefined
        ? initialCwd
        : dirname(configPath);
  const normalized: RuntimeConfig = {
    cwd,
    format: merged.format ?? "human",
    output: merged.output === undefined ? undefined : resolve(outputBase, merged.output),
    noColor: merged.noColor ?? false,
    quiet: merged.quiet ?? false,
    debug: merged.debug ?? false,
    nonInteractive: merged.nonInteractive ?? false,
    strict: merged.strict ?? false,
    failOn: merged.failOn,
    exclude: [...(merged.exclude ?? [])].sort(comparePortable),
    adapters: [...(merged.adapters ?? [])]
      .map((value) => resolve(configPath === undefined ? initialCwd : dirname(configPath), value))
      .sort(comparePortable),
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
      exclude: [...(merged.exclude ?? [])].sort(comparePortable),
      adapters: [...(merged.adapters ?? [])]
        .map((value) => resolve(configPath === undefined ? initialCwd : dirname(configPath), value))
        .sort(comparePortable),
      maxFindings: merged.maxFindings ?? 80,
    }),
  };
  return normalized;
}

async function readJsonConfig(
  path: string,
): Promise<{readonly _tag: "ok"; readonly value: FileConfig} | ConfigFailure> {
  try {
    const raw = await readFile(path, "utf8");
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

async function findNearestConfig(start: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  let current = start;
  while (true) {
    const candidate = join(current, "footgun.config.json");
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch (cause: unknown) {
      if (!isErrno(cause, "ENOENT")) throw cause;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const userConfig = join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "footgun", "config.json");
  try {
    await readFile(userConfig, "utf8");
    return userConfig;
  } catch (cause: unknown) {
    if (!isErrno(cause, "ENOENT")) throw cause;
    return undefined;
  }
}

function parseEnvironment(environment: NodeJS.ProcessEnv): FileConfig | ConfigFailure {
  const values: FileConfig = {};
  if (environment.FOOTGUN_FORMAT !== undefined) {
    if (!isOutputFormat(environment.FOOTGUN_FORMAT))
      return configFailure(
        "invalid-environment",
        "FOOTGUN_FORMAT is invalid.",
        "Expected one of " + outputFormats.join(", ") + ".",
      );
    values.format = environment.FOOTGUN_FORMAT;
  }
  if (environment.FOOTGUN_OUTPUT !== undefined) values.output = environment.FOOTGUN_OUTPUT;
  if (environment.FOOTGUN_FAIL_ON !== undefined) values.failOn = environment.FOOTGUN_FAIL_ON;
  for (const [name, key] of [
    ["FOOTGUN_NO_COLOR", "noColor"],
    ["FOOTGUN_QUIET", "quiet"],
    ["FOOTGUN_DEBUG", "debug"],
    ["FOOTGUN_NON_INTERACTIVE", "nonInteractive"],
    ["FOOTGUN_STRICT", "strict"],
  ] as const) {
    const value = environment[name];
    if (value !== undefined) {
      if (value !== "true" && value !== "false")
        return configFailure("invalid-environment", `${name} is invalid.`, "Use the literal string true or false.");
      values[key] = value === "true";
    }
  }
  if (environment.FOOTGUN_MAX_FINDINGS !== undefined) {
    const value = Number(environment.FOOTGUN_MAX_FINDINGS);
    if (!Number.isInteger(value) || value <= 0)
      return configFailure("invalid-environment", "FOOTGUN_MAX_FINDINGS is invalid.", "Use a positive integer.");
    values.maxFindings = value;
  }
  if (environment.FOOTGUN_EXCLUDE !== undefined)
    values.exclude = environment.FOOTGUN_EXCLUDE.split(",").filter((value) => value.length > 0);
  if (environment.FOOTGUN_ADAPTERS !== undefined)
    values.adapters = environment.FOOTGUN_ADAPTERS.split(",").filter((value) => value.length > 0);
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

function digestConfig(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isOutputFormat(value: string): value is OutputFormat {
  return outputFormats.some((format) => format === value);
}

function configFailure(code: string, message: string, detail: string): ConfigFailure {
  return {
    _tag: "ConfigFailure",
    schemaVersion: "footgun.problem.v1",
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
    environment.FOOTGUN_DATA_DIR ?? resolve(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "footgun")
  );
}

export function resolveConfiguredPath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}
