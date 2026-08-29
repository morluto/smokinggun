import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {readBoundedUtf8File, writeFileAtomically} from "./files.js";

it("creates parent directories and atomically replaces file contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-files-"));
  try {
    const path = join(root, "nested", "result.json");
    await writeFileAtomically(path, "first");
    await writeFileAtomically(path, "second");
    expect(await readFile(path, "utf8")).toBe("second");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("rejects invalid UTF-8 instead of replacing input bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "smokinggun-files-"));
  try {
    const path = join(root, "invalid.json");
    await writeFile(path, Buffer.from([0x22, 0xff, 0x22]));

    await expect(readBoundedUtf8File(path, 1024)).rejects.toThrow(/valid UTF-8/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
