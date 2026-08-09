import type {RuntimeContext} from "./context.js";
import type {OutputFormat} from "../config.js";
import {writeFileAtomically} from "../files.js";

/** Write a rendered result atomically when an output path was requested. */
export async function writeResult(text: string, context: RuntimeContext): Promise<void> {
  if (context.config.output === undefined) return;
  await writeFileAtomically(context.config.output, text);
}

export function shouldPrint(format: OutputFormat, quiet: boolean): boolean {
  return !quiet || format !== "human";
}
