import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {loadLatestInvestigation, recordInvestigationSnapshot, requireLatestInvestigation} from "./store.js";

describe("investigation snapshots", () => {
  it("advances through content-addressed snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-investigation-"));
    const initial = {
      schemaVersion: "footgun.investigation-bundle.v2" as const,
      id: "inv_0123456789abcdef",
      state: "scanned" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    const firstDigest = await recordInvestigationSnapshot(root, initial);
    const next = {...initial, state: "baseline-measured" as const};
    const secondDigest = await recordInvestigationSnapshot(root, next);
    expect(secondDigest).not.toBe(firstDigest);
    const latest = await loadLatestInvestigation(root, initial.id);
    expect(latest?.digest).toBe(secondDigest);
    expect(latest?.bundle.state).toBe("baseline-measured");
    expect(
      await readFile(join(root, "investigations", initial.id, "snapshots", `${secondDigest}.json`), "utf8"),
    ).toContain("baseline-measured");
  });

  it("rejects state regressions and skipped validation stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-investigation-"));
    const initial = {
      schemaVersion: "footgun.investigation-bundle.v2" as const,
      id: "inv_fedcba9876543210",
      state: "created" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    await recordInvestigationSnapshot(root, initial);
    await expect(recordInvestigationSnapshot(root, {...initial, state: "reported" as const})).rejects.toThrow(
      /Invalid investigation transition/,
    );
    await recordInvestigationSnapshot(root, {...initial, state: "inventoried" as const});
    await expect(recordInvestigationSnapshot(root, {...initial, state: "baseline-measured" as const})).rejects.toThrow(
      /Invalid investigation transition/,
    );
  });

  it("rejects missing investigations after validating their IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-investigation-"));
    await expect(requireLatestInvestigation(root, "inv_0123456789abcdef")).rejects.toThrow(
      "Investigation inv_0123456789abcdef does not exist.",
    );
    await expect(requireLatestInvestigation(root, "not-an-id")).rejects.toThrow("Invalid investigation ID.");
  });
});
