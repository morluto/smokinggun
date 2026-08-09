import {randomUUID} from "node:crypto";
import {mkdir, rename, rm, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

/** Replace one local file atomically after fully writing a sibling temporary file. */
export async function writeFileAtomically(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (cause: unknown) {
    await rm(temporary, {force: true}).catch(() => undefined);
    throw cause;
  }
}
