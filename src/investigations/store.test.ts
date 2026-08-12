import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {
  appendInvestigationEvidence,
  appendInvestigationReport,
  loadLatestInvestigation,
  recordImportedInvestigationMeasurements,
  recordInvestigationSnapshot,
  requireLatestInvestigation,
} from "./store.js";
import {stableJson} from "../serialization.js";
import {Protocol} from "../protocol/index.js";

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
      schemaVersion: "smokinggun.evidence.v2" as const,
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
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const initial = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_0123456789abcdef",
      state: "scanned" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: ["scan-report.json"],
      evidence: [scanEvidence("inv_0123456789abcdef")],
      diagnostics: [],
    };
    const firstDigest = await recordInvestigationSnapshot(root, initial, null);
    const next = {
      ...initial,
      state: "baseline-measured" as const,
      reports: ["scan-report.json", "../measurements/baseline.json"],
      evidence: [measurementEvidence(initial.id)],
    };
    const secondDigest = await recordInvestigationSnapshot(root, next, firstDigest);
    expect(secondDigest).not.toBe(firstDigest);
    const latest = await loadLatestInvestigation(root, initial.id);
    expect(latest?.digest).toBe(secondDigest);
    expect(latest?.bundle.state).toBe("baseline-measured");
    expect(latest?.parentDigest).toBe(firstDigest);
    expect(
      await readFile(join(root, "investigations", initial.id, "snapshots", `${secondDigest}.json`), "utf8"),
    ).toContain("baseline-measured");
  });

  it("advances a scanned investigation when immutable measurements are imported", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const id = "inv_abcdef0123456789";
    await recordInvestigationSnapshot(
      root,
      {
        schemaVersion: "smokinggun.investigation-bundle.v2",
        id,
        state: "scanned",
        root: ".",
        createdAt: new Date().toISOString(),
        reports: ["scan-report.json"],
        evidence: [scanEvidence(id)],
        diagnostics: [],
      },
      null,
    );
    await recordImportedInvestigationMeasurements(root, id, [
      {
        role: "baseline",
        artifact: `artifact://sha256/${"a".repeat(64)}`,
        digest: "a".repeat(64),
        claimClass: "constant-factor",
      },
      {
        role: "candidate",
        artifact: `artifact://sha256/${"b".repeat(64)}`,
        digest: "b".repeat(64),
        claimClass: "constant-factor",
      },
    ]);

    const latest = await requireLatestInvestigation(root, id);
    expect(latest.bundle.state).toBe("baseline-measured");
    expect(latest.bundle.reports).toContain(`artifact://sha256/${"a".repeat(64)}`);
    expect(latest.bundle.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({kind: "measurement", digest: "a".repeat(64)}),
        expect.objectContaining({kind: "measurement", digest: "b".repeat(64)}),
      ]),
    );
  });

  it("does not label candidate-only evidence as a measured baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const id = "inv_9876543210abcdef";
    await recordInvestigationSnapshot(
      root,
      {
        schemaVersion: "smokinggun.investigation-bundle.v2",
        id,
        state: "scanned",
        root: ".",
        createdAt: new Date().toISOString(),
        reports: ["scan-report.json"],
        evidence: [scanEvidence(id)],
        diagnostics: [],
      },
      null,
    );
    await expect(
      recordImportedInvestigationMeasurements(root, id, [
        {
          role: "candidate",
          artifact: `artifact://sha256/${"b".repeat(64)}`,
          digest: "b".repeat(64),
          claimClass: "constant-factor",
        },
      ]),
    ).rejects.toThrow(/without baseline measurement evidence/);
    expect((await requireLatestInvestigation(root, id)).bundle.state).toBe("scanned");
  });

  it("materializes a legacy bundle as an addressable parent before migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const bundle = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_aabbccddeeff0011",
      state: "created" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    const directory = join(root, "investigations", bundle.id);
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, "bundle.json"), `${stableJson(bundle)}\n`, "utf8");

    const legacy = await requireLatestInvestigation(root, bundle.id);
    await recordInvestigationSnapshot(root, {...bundle, state: "inventoried" as const}, legacy.digest);

    const parent = JSON.parse(await readFile(join(directory, "snapshots", `${legacy.digest}.json`), "utf8")) as Record<
      string,
      unknown
    >;
    expect(parent).toMatchObject({
      schemaVersion: "smokinggun.investigation-commit.v1",
      parentDigest: null,
      bundle,
    });
  });

  it("advances a legacy raw snapshot without changing its parent address", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const bundle = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_1100ffeeddccbbaa",
      state: "created" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    const parsedBundle = Protocol.investigation.parse(bundle);
    const digest = createHash("sha256").update(stableJson(parsedBundle)).digest("hex");
    const directory = join(root, "investigations", bundle.id);
    await mkdir(join(directory, "snapshots"), {recursive: true});
    await writeFile(join(directory, "snapshots", `${digest}.json`), `${stableJson(parsedBundle)}\n`, "utf8");
    await writeFile(
      join(directory, "latest.json"),
      `${stableJson({
        schemaVersion: "smokinggun.investigation-pointer.v1",
        bundleDigest: digest,
        updatedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const nextDigest = await recordInvestigationSnapshot(root, {...bundle, state: "inventoried" as const}, digest);
    expect((await requireLatestInvestigation(root, bundle.id)).parentDigest).toBe(digest);
    expect(nextDigest).not.toBe(digest);
  });

  it("rejects state regressions and skipped validation stages", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const initial = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_fedcba9876543210",
      state: "created" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    const initialDigest = await recordInvestigationSnapshot(root, initial, null);
    await expect(
      recordInvestigationSnapshot(
        root,
        {
          ...initial,
          state: "reported" as const,
          reports: ["report.md"],
          evidence: [
            {
              schemaVersion: "smokinggun.evidence.v2",
              id: `${initial.id}:report:report.md`,
              kind: "static",
              summary: "Rendered report",
              artifact: "report.md",
            },
          ],
        },
        initialDigest,
      ),
    ).rejects.toThrow(/Invalid investigation transition/);
    const inventoriedDigest = await recordInvestigationSnapshot(
      root,
      {...initial, state: "inventoried" as const},
      initialDigest,
    );
    await expect(
      recordInvestigationSnapshot(
        root,
        {
          ...initial,
          state: "baseline-measured" as const,
          reports: ["../measurements/baseline.json"],
          evidence: [measurementEvidence(initial.id)],
        },
        inventoriedDigest,
      ),
    ).rejects.toThrow(/Invalid investigation transition/);
  });

  it("rejects missing investigations after validating their IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    await expect(requireLatestInvestigation(root, "inv_0123456789abcdef")).rejects.toThrow(
      "Investigation inv_0123456789abcdef does not exist.",
    );
    await expect(requireLatestInvestigation(root, "not-an-id")).rejects.toThrow("Invalid investigation ID.");
  });

  it("rejects a snapshot whose contents no longer match its content-addressed pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const bundle = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_0011223344556677",
      state: "scanned" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: ["scan-report.json"],
      evidence: [scanEvidence("inv_0011223344556677")],
      diagnostics: [],
    };
    const digest = await recordInvestigationSnapshot(root, bundle, null);
    await writeFile(
      join(root, "investigations", bundle.id, "snapshots", `${digest}.json`),
      `${JSON.stringify({...bundle, root: "tampered"})}\n`,
      "utf8",
    );
    await expect(loadLatestInvestigation(root, bundle.id)).rejects.toThrow("does not match its content digest");
  });

  it("verifies pre-existing content-addressed entries before advancing latest", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const initial = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_1122334455667788",
      state: "created" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    const parentDigest = await recordInvestigationSnapshot(root, initial, null);
    const next = {...initial, state: "inventoried" as const};
    const bytes = `${stableJson({
      schemaVersion: "smokinggun.investigation-commit.v1",
      parentDigest,
      bundle: Protocol.investigation.parse(next),
    })}\n`;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const snapshots = join(root, "investigations", initial.id, "snapshots");
    await mkdir(snapshots, {recursive: true});
    await writeFile(join(snapshots, `${digest}.json`), "corrupt\n", "utf8");

    await expect(recordInvestigationSnapshot(root, next, parentDigest)).rejects.toThrow(
      "does not match its content digest",
    );
    expect((await loadLatestInvestigation(root, initial.id))?.digest).toBe(parentDigest);
  });

  it("allows only one child to advance an expected parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "smokinggun-investigation-"));
    const initial = {
      schemaVersion: "smokinggun.investigation-bundle.v2" as const,
      id: "inv_8877665544332211",
      state: "created" as const,
      root: ".",
      createdAt: new Date().toISOString(),
      reports: [],
      evidence: [],
      diagnostics: [],
    };
    const parentDigest = await recordInvestigationSnapshot(root, initial, null);
    const children = ["writer-one", "writer-two"].map((code) => ({
      ...initial,
      state: "inventoried" as const,
      diagnostics: [{schemaVersion: "smokinggun.problem.v1" as const, code, message: code}],
    }));
    const results = await Promise.allSettled(
      children.map((child) => recordInvestigationSnapshot(root, child, parentDigest)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const latest = await loadLatestInvestigation(root, initial.id);
    expect(latest?.parentDigest).toBe(parentDigest);
    expect(latest?.bundle.diagnostics).toHaveLength(1);
  });
});

function measurementEvidence(investigation: string) {
  return {
    schemaVersion: "smokinggun.evidence.v2" as const,
    id: `${investigation}:measurement:baseline`,
    kind: "measurement" as const,
    claimClass: "constant-factor" as const,
    summary: "Baseline measurement",
    artifact: "../measurements/baseline.json",
  };
}

function scanEvidence(investigation: string) {
  return {
    schemaVersion: "smokinggun.evidence.v2" as const,
    id: `${investigation}:scan`,
    kind: "static" as const,
    claimClass: "static-fact" as const,
    summary: "Scan",
    artifact: "scan-report.json",
  };
}
