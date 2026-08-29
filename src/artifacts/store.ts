import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {link, lstat, mkdir, open, rm} from "node:fs/promises";
import {basename, join} from "node:path";
import {randomUUID} from "node:crypto";

export type StoredArtifact = {
  readonly reference: string;
  readonly digest: string;
  readonly size: number;
  readonly name: string;
  readonly path: string;
};

/** Copy a bounded local artifact into an immutable content-addressed store. */
export async function storeArtifact(
  sourcePath: string,
  root: string,
  maxBytes = 100 * 1024 * 1024,
): Promise<StoredArtifact> {
  const bytes = await readArtifactBytes(sourcePath, maxBytes);
  return storeArtifactBytes(sourcePath, bytes, root, maxBytes);
}

/** Persist bytes already accepted at an input boundary under their immutable content digest. */
export async function storeArtifactBytes(
  sourcePath: string,
  bytes: Uint8Array,
  root: string,
  maxBytes = 100 * 1024 * 1024,
): Promise<StoredArtifact> {
  if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes} byte limit.`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, "sha256");
  const destination = join(directory, digest);
  await mkdir(directory, {recursive: true});
  try {
    const existing = await readArtifactBytes(destination, bytes.byteLength);
    if (existing.byteLength !== bytes.byteLength)
      throw new Error("The content-addressed artifact destination does not match its digest.");
    const existingDigest = createHash("sha256").update(existing).digest("hex");
    if (existingDigest !== digest)
      throw new Error("The content-addressed artifact destination does not match its digest.");
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    const temporary = join(directory, `.${digest}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporary, destination);
      } catch (linkCause: unknown) {
        if (!(linkCause instanceof Error && "code" in linkCause && linkCause.code === "EEXIST")) throw linkCause;
        const existing = await readArtifactBytes(destination, bytes.byteLength);
        if (!existing.equals(bytes))
          throw new Error("The content-addressed artifact destination does not match its digest.");
      }
      await rm(temporary, {force: true});
    } catch (writeCause: unknown) {
      await rm(temporary, {force: true}).catch(() => undefined);
      throw writeCause;
    }
  }
  return {
    reference: `artifact://sha256/${digest}`,
    digest,
    size: bytes.byteLength,
    name: basename(sourcePath),
    path: destination,
  };
}

/** Read a bounded regular, non-symlink artifact without persisting it. */
export async function readArtifactBytes(path: string, maxBytes = 100 * 1024 * 1024): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
