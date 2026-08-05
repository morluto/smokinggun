import {shouldPrint, writeResult} from "./output.js";
import type {RuntimeContext} from "./context.js";
import type {OutputFormat} from "../config.js";

export async function printResult(value: unknown, human: string, context: RuntimeContext): Promise<void> {
  const rendered = renderCommandResult(value, human, context.config.format);
  await writeResult(rendered, context);
  if (shouldPrint(context.config.format, context.config.quiet)) context.stdout.write(rendered);
}

/** Render a command result through the common stream contract. */
export function renderCommandResult(value: unknown, human: string, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  if (format === "markdown") return `# Footgun\n\n${human}\n`;
  if (format === "sarif") return `${JSON.stringify(toGenericSarif(value, human), null, 2)}\n`;
  return `${human}\n`;
}

function toGenericSarif(value: unknown, human: string): Record<string, unknown> {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: {driver: {name: "footgun", version: "1.0.0"}},
      results: [],
      invocations: [{executionSuccessful: true}],
      properties: {message: human, value},
    }],
  };
}
