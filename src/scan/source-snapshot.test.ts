import {createHash} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {captureSourceSnapshot} from "./source-snapshot.js";

describe("source snapshot capture", () => {
  it("binds canonical paths to exact source bytes independently of target order", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-source-snapshot-"));
    try {
      const firstPath = join(root, "a.ts");
      const secondPath = join(root, "b.ts");
      await writeFile(firstPath, Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x7b, 0x7d, 0x0a]));
      await writeFile(secondPath, "export const b = 2;\n", "utf8");

      const first = await captureSourceSnapshot(root, [secondPath, firstPath]);
      const second = await captureSourceSnapshot(root, [firstPath, secondPath]);

      expect(first.digest).toBe(second.digest);
      expect(first.capturedFiles.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
      expect(first.capturedFiles[0]?.digest).toBe(
        createHash("sha256").update(Buffer.from("export {}\n", "utf8")).digest("hex"),
      );
      expect(first.isComplete).toBe(true);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("commits visible size and encoding omissions to the snapshot identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-source-snapshot-"));
    try {
      const validPath = join(root, "valid.ts");
      const oversizedPath = join(root, "oversized.ts");
      const invalidPath = join(root, "invalid.ts");
      await writeFile(validPath, "ok", "utf8");
      await writeFile(oversizedPath, "12345", "utf8");
      await writeFile(invalidPath, Buffer.from([0xff]));

      const bounded = await captureSourceSnapshot(root, [validPath, oversizedPath, invalidPath], {
        maxFiles: 3,
        maxDirectories: 10,
        maxDepth: 10,
        maxFileBytes: 4,
        maxTotalBytes: 10,
      });
      const complete = await captureSourceSnapshot(root, [validPath], {
        maxFiles: 3,
        maxDirectories: 10,
        maxDepth: 10,
        maxFileBytes: 4,
        maxTotalBytes: 10,
      });

      expect(bounded.files).toEqual([
        {_tag: "unavailable", path: "invalid.ts", reason: "invalid-utf8"},
        {_tag: "unavailable", path: "oversized.ts", reason: "file-size-limit"},
        expect.objectContaining({_tag: "captured", path: "valid.ts", size: 2}),
      ]);
      expect(bounded.isComplete).toBe(false);
      expect(bounded.digest).not.toBe(complete.digest);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it("applies total and file-count limits deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-source-snapshot-"));
    try {
      const paths = [join(root, "a.ts"), join(root, "b.ts"), join(root, "c.ts")];
      await Promise.all(paths.map((path) => writeFile(path, "123", "utf8")));

      const snapshot = await captureSourceSnapshot(root, [...paths].reverse(), {
        maxFiles: 2,
        maxDirectories: 10,
        maxDepth: 10,
        maxFileBytes: 10,
        maxTotalBytes: 4,
      });

      expect(snapshot.files).toEqual([
        expect.objectContaining({_tag: "captured", path: "a.ts"}),
        {_tag: "unavailable", path: "b.ts", reason: "total-size-limit"},
        {_tag: "unavailable", path: "c.ts", reason: "file-count-limit"},
      ]);
      expect(snapshot.capturedBytes).toBe(3);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
