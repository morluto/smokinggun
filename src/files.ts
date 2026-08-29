import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {mkdir, open, rename, rm, writeFile} from "node:fs/promises";
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

/** Read one regular UTF-8 file with allocation bounded by the declared byte limit. */
export async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only regular files can be read.");
    if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte limit.`);
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte limit.`);
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}
