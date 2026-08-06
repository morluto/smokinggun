import {isAbsolute, relative} from "node:path";
import {portablePath} from "../paths.js";

const inheritedEnvironmentKeys = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "ComSpec",
]);

/** Provide only non-secret process settings unless a workload explicitly opts into full inheritance. */
export function executionEnvironment(
  explicit: Readonly<Record<string, string>>,
  inheritAll: boolean,
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (inheritAll || inheritedEnvironmentKeys.has(key))) inherited[key] = value;
  }
  return {...inherited, ...explicit};
}

/** Redact secret-looking values before putting subprocess details into diagnostics. */
export function redactSensitive(value: string): string {
  return value.replace(
    /((?:token|password|passwd|secret|api[_-]?key|authorization)[=:\s]+)([^\s,]+)/gi,
    "$1[REDACTED]",
  );
}

/** Keep reproduction commands useful while removing host paths and secret-looking arguments. */
export function redactCommand(command: ReadonlyArray<string>, root: string): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const argument of command) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    if (/^(?:--?)(?:token|password|passwd|secret|api[_-]?key|authorization)$/i.test(argument)) {
      redacted.push(argument);
      redactNext = true;
      continue;
    }
    if (isAbsolute(argument)) {
      const path = relative(root, argument);
      redacted.push(isAbsolute(path) || path.startsWith("..") ? "[HOST_PATH]" : portablePath(path || "."));
      continue;
    }
    redacted.push(redactSensitive(argument));
  }
  return redacted;
}
