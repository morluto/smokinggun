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
    return decodeUtf8Bytes(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

/** Decode exact textual input bytes without silently replacing malformed UTF-8. */
export function decodeUtf8Bytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {
    throw new InvalidUtf8Error();
  }
}

/** Whether a textual input failed strict UTF-8 decoding. */
export function isInvalidUtf8Error(cause: unknown): boolean {
  return cause instanceof InvalidUtf8Error;
}

class InvalidUtf8Error extends Error {
  constructor() {
    super("File is not valid UTF-8.");
    this.name = "InvalidUtf8Error";
  }
}
