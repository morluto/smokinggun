/** Redact secret-looking values before putting failure details into diagnostics. */
export function redactSensitive(value: string): string {
  return value
    .replace(/((?:authorization)[=:\s]+)(?:Bearer|Basic)\s+[^\s,]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|passwd|secret|api[_-]?key|authorization)[=:\s]+)([^\s,]+)/gi, "$1[REDACTED]");
}
