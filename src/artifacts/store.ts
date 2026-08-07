import {createHash} from "node:crypto";
import {lstat, mkdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
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
  const linkInfo = await lstat(sourcePath);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile())
    throw new Error("Only regular, non-symlink files can be stored as artifacts.");
  const info = await stat(sourcePath);
  if (info.size > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes} byte limit.`);
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes} byte limit.`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, "sha256");
  const destination = join(directory, digest);
  await mkdir(directory, {recursive: true});
  try {
    const destinationInfo = await lstat(destination);
    if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile())
      throw new Error("The content-addressed artifact destination is not a regular file.");
    if (destinationInfo.size !== bytes.byteLength)
      throw new Error("The content-addressed artifact destination does not match its digest.");
    const existingDigest = createHash("sha256")
      .update(await readFile(destination))
      .digest("hex");
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
