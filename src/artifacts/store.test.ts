import {existsSync} from "node:fs";
import {mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {storeArtifact, storeArtifactBytes} from "./store.js";

it("stores regular artifacts by digest and rejects symlink inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-artifact-store-"));
  try {
    const source = join(root, "report.json");
    const store = join(root, "store");
    await writeFile(source, "{}", "utf8");
    const first = await storeArtifact(source, store);
    const second = await storeArtifact(source, store);
    expect(first).toEqual(second);
    expect(first.reference).toBe(`artifact://sha256/${first.digest}`);
    expect(existsSync(join(store, "sha256", first.digest))).toBe(true);
    const link = join(root, "link.json");
    await symlink(source, link);
    await expect(storeArtifact(link, store)).rejects.toThrow(/regular, non-symlink/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("rejects an existing artifact path whose bytes do not match its digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-artifact-store-"));
  try {
    const source = join(root, "report.json");
    const store = join(root, "store");
    await writeFile(source, "expected", "utf8");
    const expected = await storeArtifact(source, store);
    await writeFile(join(store, "sha256", expected.digest), "corrupt!", "utf8");
    await expect(storeArtifact(source, store)).rejects.toThrow(/does not match its digest/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

it("stores the exact bytes already accepted by a command boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "footgun-artifact-store-"));
  try {
    const store = join(root, "store");
    const stored = await storeArtifactBytes("report.json", Buffer.from("validated", "utf8"), store);
    expect(await readFile(join(store, "sha256", stored.digest), "utf8")).toBe("validated");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
