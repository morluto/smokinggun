import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  loadLatestInvestigation,
  recordInvestigationSnapshot,
  requireLatestInvestigation,
} from "./store.js";

describe("investigation snapshots", () => {
  it("deduplicates reports in canonical portable-path order", () => {
    expect(appendInvestigationReport(["z-report.json", "a-report.json"], "m-report.json")).toEqual([
      "a-report.json",
      "m-report.json",
      "z-report.json",
    ]);
    expect(appendInvestigationReport(["a-report.json"], "a-report.json")).toEqual(["a-report.json"]);
  });

  it("makes identical evidence insertion idempotent and rejects redefinition", () => {
    const evidence = {
      schemaVersion: "footgun.evidence.v2" as const,
      id: "evidence:scan",
      kind: "static" as const,
      summary: "Scan",
    };
    expect(appendInvestigationEvidence([], evidence)).toEqual([evidence]);
    expect(appendInvestigationEvidence([evidence], evidence)).toEqual([evidence]);
    expect(() => appendInvestigationEvidence([evidence], {...evidence, summary: "Different scan"})).toThrow(
      /conflicts with an existing record/,
    );
  });

  it("advances through content-addressed snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-investigation-"));
    const initial = {
      schemaVersion: "footgun.investigation-bundle.v2" as const,
      id: "inv_0123456789abcdef",
      state: "scanned" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: ["scan-report.json"],
      evidence: [scanEvidence("inv_0123456789abcdef")],
      diagnostics: [],
    };
    const firstDigest = await recordInvestigationSnapshot(root, initial);
    const next = {
      ...initial,
      state: "baseline-measured" as const,
      reports: ["scan-report.json", "../measurements/baseline.json"],
      evidence: [measurementEvidence(initial.id)],
    };
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
    await expect(
      recordInvestigationSnapshot(root, {
        ...initial,
        state: "reported" as const,
        reports: ["report.md"],
        evidence: [
          {
            schemaVersion: "footgun.evidence.v2",
            id: `${initial.id}:report:report.md`,
            kind: "static",
            summary: "Rendered report",
            artifact: "report.md",
          },
        ],
      }),
    ).rejects.toThrow(/Invalid investigation transition/);
    await recordInvestigationSnapshot(root, {...initial, state: "inventoried" as const});
    await expect(
      recordInvestigationSnapshot(root, {
        ...initial,
        state: "baseline-measured" as const,
        reports: ["../measurements/baseline.json"],
        evidence: [measurementEvidence(initial.id)],
      }),
    ).rejects.toThrow(/Invalid investigation transition/);
  });

  it("rejects missing investigations after validating their IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-investigation-"));
    await expect(requireLatestInvestigation(root, "inv_0123456789abcdef")).rejects.toThrow(
      "Investigation inv_0123456789abcdef does not exist.",
    );
    await expect(requireLatestInvestigation(root, "not-an-id")).rejects.toThrow("Invalid investigation ID.");
  });

  it("rejects a snapshot whose contents no longer match its content-addressed pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "footgun-investigation-"));
    const bundle = {
      schemaVersion: "footgun.investigation-bundle.v2" as const,
      id: "inv_0011223344556677",
      state: "scanned" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: ["scan-report.json"],
      evidence: [scanEvidence("inv_0011223344556677")],
      diagnostics: [],
    };
    const digest = await recordInvestigationSnapshot(root, bundle);
    await writeFile(
      join(root, "investigations", bundle.id, "snapshots", `${digest}.json`),
      `${JSON.stringify({...bundle, root: "tampered"})}\n`,
      "utf8",
    );
    await expect(loadLatestInvestigation(root, bundle.id)).rejects.toThrow("does not match its content digest");
  });
});

function measurementEvidence(investigation: string) {
  return {
    schemaVersion: "footgun.evidence.v2" as const,
    id: `${investigation}:measurement:baseline`,
    kind: "measurement" as const,
    claimClass: "constant-factor" as const,
    summary: "Baseline measurement",
    artifact: "../measurements/baseline.json",
  };
}

function scanEvidence(investigation: string) {
  return {
    schemaVersion: "footgun.evidence.v2" as const,
    id: `${investigation}:scan`,
    kind: "static" as const,
    claimClass: "static-fact" as const,
    summary: "Scan",
    artifact: "scan-report.json",
  };
}
