import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {buildRepositoryInventory} from "./inventory.js";

describe("repository inventory", () => {
  it("recognizes package manifests only when they are regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-inventory-"));
    try {
      await writeFile(join(root, "package.json"), "{}\n", "utf8");
      await mkdir(join(root, "go.mod"));

      const inventory = await buildRepositoryInventory(root, [], []);

      expect(inventory.manifests).toEqual(["package.json"]);
      expect(inventory.packageManagers).toEqual(["npm"]);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
