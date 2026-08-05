import {Command, Flags} from "@oclif/core";
import {createRuntimeContext, isContextFailure, type GlobalFlags, type RuntimeContext} from "./context.js";
import type {OutputFormat} from "../config.js";
import type {ActionRequiredV1, ProblemV1} from "../protocol/index.js";
import {redactSensitive} from "../execution/environment.js";

export const globalFlags = {
  cwd: Flags.string({description: "Repository working directory."}),
  config: Flags.string({description: "Explicit JSON configuration path."}),
  format: Flags.string({description: "Output format.", options: ["human", "json", "markdown", "sarif"]}),
  output: Flags.string({description: "Also write the rendered document to this path."}),
  "no-color": Flags.boolean({description: "Disable color in human output."}),
  quiet: Flags.boolean({description: "Suppress human result output."}),
  debug: Flags.boolean({description: "Include debugging diagnostics on stderr."}),
  "non-interactive": Flags.boolean({description: "Never prompt for missing choices."}),
  strict: Flags.boolean({description: "Fail when requested coverage is incomplete."}),
  "fail-on": Flags.string({description: "Exit 4 when a finding matches a severity, rule ID, or finding."}),
  exclude: Flags.string({description: "Directory name to exclude.", multiple: true}),
  "max-findings": Flags.integer({description: "Maximum findings to emit.", min: 1}),
} as const;

export type ParsedGlobalFlags = {
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
  readonly maxFindings?: number;
};

export abstract class BaseCommand extends Command {
  static override flags = globalFlags;

  protected async context(flags: ParsedGlobalFlags): Promise<RuntimeContext> {
    const controller = new AbortController();
    const onSignal = (): void => controller.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.once("exit", () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    });
    let result: Awaited<ReturnType<typeof createRuntimeContext>>;
    const normalizedFlags = normalizeFlags(flags);
    try {
      result = await createRuntimeContext(normalizedFlags, controller.signal);
    } catch (cause: unknown) {
      if (controller.signal.aborted) this.emitProblem({schemaVersion: "footgun.problem.v1", code: "cancelled", message: "The command was cancelled.", recovery: "Rerun the command when the local resources are available."}, 130, undefined, normalizedFlags.format);
      this.emitProblem({schemaVersion: "footgun.problem.v1", code: "runtime-context-failed", message: "Footgun could not initialize its local runtime context.", ...(normalizedFlags.debug && cause instanceof Error ? {detail: redactSensitive(cause.message)} : {}), recovery: "Check the working directory, configuration, and local data directory."}, 1, undefined, normalizedFlags.format);
    }
    if (!isContextFailure(result)) return result;
    const {_tag: _contextTag, exitCode: _exitCode, ...problem} = result;
    this.emitProblem(problem, result.exitCode, undefined, normalizedFlags.format);
    throw new Error("unreachable");
  }

  protected emit(text: string, context: RuntimeContext): void {
    context.stdout.write(text);
  }

  protected emitProblem(problem: ProblemV1, exitCode: number, context?: RuntimeContext, requestedFormat?: OutputFormat): never {
    const safeProblem: ProblemV1 = {
      schemaVersion: problem.schemaVersion,
      code: problem.code,
      message: problem.message,
      ...(problem.detail === undefined ? {} : {detail: problem.detail}),
      ...(problem.path === undefined ? {} : {path: problem.path}),
      ...(problem.recovery === undefined ? {} : {recovery: problem.recovery}),
    };
    const format = context?.config.format ?? requestedFormat ?? "human";
    if (format === "json") {
      if (context === undefined) process.stdout.write(`${JSON.stringify(safeProblem)}\n`);
      else context.stdout.write(`${JSON.stringify(safeProblem)}\n`);
    } else if (format === "sarif") {
      const document = JSON.stringify({version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{tool: {driver: {name: "footgun", version: "1.0.0"}}, results: [], invocations: [{executionSuccessful: false, toolExecutionNotifications: [{level: "error", message: {text: safeProblem.message}, properties: safeProblem}]}], properties: {schemaVersion: "footgun.problem.v1", problem: safeProblem}}]});
      if (context === undefined) process.stdout.write(`${document}\n`);
      else context.stdout.write(`${document}\n`);
    } else if (context === undefined) {
      process.stderr.write(`${safeProblem.message}\n`);
    } else {
      context.stderr.write(`${safeProblem.message}\n`);
    }
    this.exit(exitCode);
  }

  protected emitActionRequired(action: ActionRequiredV1, context: RuntimeContext): never {
    if (context.config.format === "json") context.stdout.write(`${JSON.stringify(action)}\n`);
    else if (context.config.format === "sarif") context.stdout.write(`${JSON.stringify({version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{tool: {driver: {name: "footgun", version: "1.0.0"}}, results: [], invocations: [{executionSuccessful: false, toolExecutionNotifications: [{level: "warning", message: {text: action.explanation}, properties: action}]}], properties: {schemaVersion: action.schemaVersion, actionRequired: action}}]})}\n`);
    else context.stderr.write(`${action.explanation}\nRecovery: ${action.recoveryCommands.join("; ")}\n`);
    this.exit(2);
  }
}

function normalizeFlags(flags: ParsedGlobalFlags): GlobalFlags {
  // SAFETY: oclif has already validated this object against globalFlags; this view only remaps names.
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(flags));
  const normalized: {-readonly [Key in keyof GlobalFlags]?: GlobalFlags[Key]} = {};
  const stringValue = (name: string): string | undefined => typeof input[name] === "string" ? input[name] : undefined;
  const booleanValue = (name: string): boolean | undefined => typeof input[name] === "boolean" ? input[name] : undefined;
  const numberValue = (name: string): number | undefined => typeof input[name] === "number" ? input[name] : undefined;
  const cwd = stringValue("cwd"); if (cwd !== undefined) normalized.cwd = cwd;
  const config = stringValue("config"); if (config !== undefined) normalized.config = config;
  const format = stringValue("format"); if (format === "human" || format === "json" || format === "markdown" || format === "sarif") normalized.format = format;
  const output = stringValue("output"); if (output !== undefined) normalized.output = output;
  const noColor = booleanValue("no-color") ?? booleanValue("noColor"); if (noColor !== undefined) normalized.noColor = noColor;
  const quiet = booleanValue("quiet"); if (quiet !== undefined) normalized.quiet = quiet;
  const debug = booleanValue("debug"); if (debug !== undefined) normalized.debug = debug;
  const nonInteractive = booleanValue("non-interactive") ?? booleanValue("nonInteractive"); if (nonInteractive !== undefined) normalized.nonInteractive = nonInteractive;
  const strict = booleanValue("strict"); if (strict !== undefined) normalized.strict = strict;
  const failOn = stringValue("fail-on") ?? stringValue("failOn"); if (failOn !== undefined) normalized.failOn = failOn;
  const exclude = input.exclude; if (Array.isArray(exclude) && exclude.every((value): value is string => typeof value === "string")) normalized.exclude = exclude;
  const maxFindings = numberValue("max-findings") ?? numberValue("maxFindings"); if (maxFindings !== undefined) normalized.maxFindings = maxFindings;
  return normalized;
}
