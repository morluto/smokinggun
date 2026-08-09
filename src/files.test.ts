import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {writeFileAtomically} from "./files.js";

it("creates parent directories and atomically replaces file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-files-"));
  try {
    const path = join(root, "nested", "result.json");
    await writeFileAtomically(path, "first");
    await writeFileAtomically(path, "second");
    expect(await readFile(path, "utf8")).toBe("second");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
