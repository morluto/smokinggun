import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat, mkdir, open, rename, rm, writeFile} from "node:fs/promises";
import {basename, join} from "node:path";
import {randomUUID} from "node:crypto";

export type StoredArtifact = {
  readonly reference: string;
  readonly digest: string;
  readonly size: number;
  readonly name: string;
};

/** Copy a bounded local artifact into an immutable content-addressed store. */
export async function storeArtifact(
  sourcePath: string,
  root: string,
  maxBytes = 100 * 1024 * 1024,
): Promise<StoredArtifact> {
  const bytes = await readRegularFile(sourcePath, maxBytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, "sha256");
  const destination = join(directory, digest);
  await mkdir(directory, {recursive: true});
  try {
    const existing = await readRegularFile(destination, bytes.byteLength);
    if (existing.byteLength !== bytes.byteLength)
      throw new Error("The content-addressed artifact destination does not match its digest.");
    const existingDigest = createHash("sha256").update(existing).digest("hex");
    if (existingDigest !== digest)
      throw new Error("The content-addressed artifact destination does not match its digest.");
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, {flag: "wx"});
      await rename(temporary, destination);
    } catch (writeCause: unknown) {
      await rm(temporary, {force: true}).catch(() => undefined);
      throw writeCause;
    }
  }
  return {reference: `artifact://sha256/${digest}`, digest, size: bytes.byteLength, name: basename(sourcePath)};
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ELOOP")
      throw new Error("Only regular, non-symlink files can be stored as artifacts.");
    throw cause;
  }
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Only regular, non-symlink files can be stored as artifacts.");
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only regular, non-symlink files can be stored as artifacts.");
    if (info.size > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes} byte limit.`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes} byte limit.`);
    return bytes;
  } finally {
    await handle.close();
  }
}
