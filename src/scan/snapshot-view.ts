import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {isWithinRoot} from "../paths.js";
import type {SourceSnapshot} from "./source-snapshot.js";

/** Materialize captured bytes into a private view used only behind a read-only sandbox mount. */
export async function withSourceSnapshotView<T>(
  snapshot: SourceSnapshot,
  use: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-source-"));
  try {
    for (const file of snapshot.capturedFiles) {
      const path = resolve(root, file.path);
      if (!isWithinRoot(root, path)) throw new Error("A captured source path escapes its materialized view.");
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, file.bytes, {flag: "wx", mode: 0o444});
    }
    return await use(root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}
