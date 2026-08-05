import {mkdir, rename, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
import type {RuntimeContext} from "./context.js";
import type {OutputFormat} from "../config.js";

/** Write a rendered result atomically when an output path was requested. */
export async function writeResult(text: string, context: RuntimeContext): Promise<void> {
  if (context.config.output === undefined) return;
  const target = context.config.output;
  await mkdir(dirname(target), {recursive: true});
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, target);
}

export function shouldPrint(format: OutputFormat, quiet: boolean): boolean {
  return !quiet || format !== "human";
}
