import {createHash, randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {mkdir, open, rename, rm, stat, unlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
  Protocol,
  type EvidenceRecordV2,
  type InvestigationBundleV2,
  type InvestigationPointerV1,
} from "../protocol/index.js";
import {comparePortable} from "../paths.js";
import {stableJson} from "../serialization.js";
import {decodeUtf8Bytes, isInvalidUtf8Error, writeFileAtomically} from "../files.js";

type StoredInvestigation = {
  readonly bundle: InvestigationBundleV2;
  readonly digest: string;
  readonly parentDigest: string | null;
  readonly storageFormat: "commit" | "legacy-snapshot" | "legacy-bundle";
};

/** One immutable measurement artifact being attached to an investigation. */
export type InvestigationMeasurementImport = {
  readonly role: "baseline" | "candidate";
  readonly artifact: string;
  readonly digest: string;
  readonly claimClass: "constant-factor" | "empirical-scaling";
};

type InvestigationCommitV1 = {
  readonly schemaVersion: "smokinggun.investigation-commit.v1";
  readonly parentDigest: string | null;
  readonly bundle: InvestigationBundleV2;
};

const reportAttachableStates = new Set<InvestigationBundleV2["state"]>([
  "scanned",
  "context-resolved",
  "measurement-planned",
  "baseline-measured",
  "candidate-compared",
  "behavior-validated",
]);

const contextSourceStates = new Set<InvestigationBundleV2["state"]>([
  "scanned",
  "context-resolved",
  "measurement-planned",
]);

const measurementImportableStates = new Set<InvestigationBundleV2["state"]>([
  "scanned",
  "context-resolved",
  "measurement-planned",
  "baseline-measured",
  "candidate-compared",
]);

export function canAttachReport(bundle: InvestigationBundleV2): boolean {
  return reportAttachableStates.has(bundle.state);
}

/** Whether this bundle can retain imported semantic context. */
export function canRecordContext(bundle: InvestigationBundleV2): boolean {
  return contextSourceStates.has(bundle.state);
}

/** Add evidence once by stable ID, rejecting attempts to silently redefine existing evidence. */
export function appendInvestigationEvidence(
  evidence: ReadonlyArray<EvidenceRecordV2>,
  next: EvidenceRecordV2,
): EvidenceRecordV2[] {
  const existing = evidence.find((record) => record.id === next.id);
  if (existing === undefined) return [...evidence, next];
  if (stableJson(existing) !== stableJson(next))
    throw new Error(`Investigation evidence ${next.id} conflicts with an existing record.`);
  return [...evidence];
}

/** Add a report once and preserve the protocol's canonical portable-path order. */
export function appendInvestigationReport(reports: ReadonlyArray<string>, next: string): string[] {
  return [...new Set([...reports, next])].sort(comparePortable);
}

/** Read the newest immutable investigation snapshot, falling back to its initial bundle. */
export async function loadLatestInvestigation(dataRoot: string, id: string): Promise<StoredInvestigation | undefined> {
  const directory = investigationDirectory(dataRoot, id);
  const pointerText = await readOptional(join(directory, "latest.json"));
  if (pointerText !== undefined) {
    const pointerInput: unknown = JSON.parse(pointerText);
    const pointer = Protocol.investigationPointer.parse(pointerInput);
    const snapshotText = await readOptional(join(directory, "snapshots", `${pointer.bundleDigest}.json`));
    if (snapshotText === undefined) throw new Error(`Investigation snapshot ${pointer.bundleDigest} is missing.`);
    const snapshotInput: unknown = JSON.parse(snapshotText);
    const isCommit = isCommitInput(snapshotInput);
    const commit = parseCommit(snapshotInput);
    const actualDigest = isCommit ? digestCommit(commit) : digestBundle(commit.bundle);
    if (actualDigest !== pointer.bundleDigest)
      throw new Error(`Investigation snapshot ${pointer.bundleDigest} does not match its content digest.`);
    return {
      bundle: commit.bundle,
      digest: pointer.bundleDigest,
      parentDigest: commit.parentDigest,
      storageFormat: isCommit ? "commit" : "legacy-snapshot",
    };
  }
  const bundleText = await readOptional(join(directory, "bundle.json"));
  if (bundleText === undefined) return undefined;
  const bundleInput: unknown = JSON.parse(bundleText);
  const bundle = Protocol.investigation.parse(bundleInput);
  const commit: InvestigationCommitV1 = {
    schemaVersion: "smokinggun.investigation-commit.v1",
    parentDigest: null,
    bundle,
  };
  return {bundle, digest: digestCommit(commit), parentDigest: null, storageFormat: "legacy-bundle"};
}

/** Load an existing investigation or fail before a command performs dependent work. */
export async function requireLatestInvestigation(dataRoot: string, id: string): Promise<StoredInvestigation> {
  const investigation = await loadLatestInvestigation(dataRoot, id);
  if (investigation === undefined) throw new Error(`Investigation ${id} does not exist.`);
  return investigation;
}

/** Retain imported measurement evidence and advance the investigation before comparison. */
export async function recordImportedInvestigationMeasurements(
  dataRoot: string,
  id: string,
  measurements: ReadonlyArray<InvestigationMeasurementImport>,
): Promise<void> {
  const stored = await requireLatestInvestigation(dataRoot, id);
  const existingDigests = new Set(
    stored.bundle.evidence.flatMap((evidence) =>
      evidence.kind === "measurement" && evidence.digest !== undefined ? [evidence.digest] : [],
    ),
  );
  if (stored.bundle.state === "behavior-validated") {
    const missing = measurements.find((measurement) => !existingDigests.has(measurement.digest));
    if (missing !== undefined)
      throw new Error(`Investigation ${id} is behavior-validated and cannot import measurement ${missing.digest}.`);
    return;
  }
  if (!measurementImportableStates.has(stored.bundle.state))
    throw new Error(`Investigation ${id} cannot import measurements while in ${stored.bundle.state} state.`);
  const hasBaseline =
    stored.bundle.evidence.some(
      (evidence) => evidence.kind === "measurement" && evidence.id.startsWith(`${id}:measurement:baseline:`),
    ) || measurements.some((measurement) => measurement.role === "baseline");
  if (!hasBaseline)
    throw new Error(`Investigation ${id} cannot become baseline-measured without baseline measurement evidence.`);
  const reports = measurements.reduce(
    (current, measurement) => appendInvestigationReport(current, measurement.artifact),
    [...stored.bundle.reports],
  );
  const evidence = measurements.reduce(
    (current, measurement) =>
      appendInvestigationEvidence(current, {
        schemaVersion: "smokinggun.evidence.v2",
        id: `${id}:measurement:${measurement.role}:${measurement.digest}`,
        kind: "measurement",
        claimClass: measurement.claimClass,
        summary: `Imported ${measurement.role} measurement artifact`,
        artifact: measurement.artifact,
        digest: measurement.digest,
      }),
    [...stored.bundle.evidence],
  );
  const nextState = stored.bundle.state === "candidate-compared" ? "candidate-compared" : "baseline-measured";
  if (
    stored.bundle.state === nextState &&
    stableJson(stored.bundle.reports) === stableJson(reports) &&
    stableJson(stored.bundle.evidence) === stableJson(evidence)
  )
    return;
  await recordParsedInvestigationSnapshot(
    dataRoot,
    {
      ...stored.bundle,
      state: nextState,
      reports,
      evidence,
    },
    stored.digest,
  );
}

/** Validate untrusted bundle input before storing an immutable snapshot. */
export async function recordInvestigationSnapshot(
  dataRoot: string,
  bundleInput: unknown,
  expectedParentDigest: string | null,
): Promise<string> {
  return recordParsedInvestigationSnapshot(dataRoot, Protocol.investigation.parse(bundleInput), expectedParentDigest);
}

/** Store a bundle that has already crossed the investigation schema boundary. */
export async function recordParsedInvestigationSnapshot(
  dataRoot: string,
  bundle: InvestigationBundleV2,
  expectedParentDigest: string | null,
): Promise<string> {
  const directory = investigationDirectory(dataRoot, bundle.id);
  await mkdir(directory, {recursive: true});
  const release = await acquireUpdateLock(directory);
  try {
    const latest = await loadLatestInvestigation(dataRoot, bundle.id);
    const actualParentDigest = latest?.digest ?? null;
    if (actualParentDigest !== expectedParentDigest)
      throw new Error(
        `Investigation update conflict: expected parent ${expectedParentDigest ?? "none"}, current parent is ${actualParentDigest ?? "none"}.`,
      );
    if (
      latest !== undefined &&
      latest.bundle.state !== bundle.state &&
      !isAllowedTransition(latest.bundle.state, bundle.state)
    )
      throw new Error(`Invalid investigation transition from ${latest.bundle.state} to ${bundle.state}.`);

    if (latest?.storageFormat === "legacy-bundle") {
      const parentCommit: InvestigationCommitV1 = {
        schemaVersion: "smokinggun.investigation-commit.v1",
        parentDigest: latest.parentDigest,
        bundle: latest.bundle,
      };
      if (digestCommit(parentCommit) !== latest.digest)
        throw new Error(`Investigation parent ${latest.digest} does not match its immutable commit bytes.`);
      const snapshots = join(directory, "snapshots");
      await mkdir(snapshots, {recursive: true});
      await writeImmutableSnapshot(
        join(snapshots, `${latest.digest}.json`),
        Buffer.from(`${stableJson(parentCommit)}\n`, "utf8"),
      );
    }

    const commit: InvestigationCommitV1 = {
      schemaVersion: "smokinggun.investigation-commit.v1",
      parentDigest: expectedParentDigest,
      bundle,
    };
    const bytes = Buffer.from(`${stableJson(commit)}\n`, "utf8");
    const digest = digestCommit(commit);
    const snapshots = join(directory, "snapshots");
    await mkdir(snapshots, {recursive: true});
    await writeImmutableSnapshot(join(snapshots, `${digest}.json`), bytes);
    const pointer: InvestigationPointerV1 = {
      schemaVersion: "smokinggun.investigation-pointer.v1",
      bundleDigest: digest,
      updatedAt: new Date().toISOString(),
    };
    await writeFileAtomically(join(directory, "latest.json"), `${stableJson(pointer)}\n`);
    return digest;
  } finally {
    await release();
  }
}

const terminalStates = new Set<InvestigationBundleV2["state"]>([
  "blocked",
  "inconclusive",
  "unavailable",
  "cancelled",
  "failed",
]);

function isAllowedTransition(from: InvestigationBundleV2["state"], to: InvestigationBundleV2["state"]): boolean {
  if (terminalStates.has(from)) return false;
  if (terminalStates.has(to)) return true;
  const transitions: Record<InvestigationBundleV2["state"], ReadonlyArray<InvestigationBundleV2["state"]>> = {
    created: ["inventoried"],
    inventoried: ["scanned", "measurement-planned"],
    scanned: ["context-resolved", "measurement-planned", "baseline-measured", "reported"],
    "context-resolved": ["measurement-planned", "baseline-measured", "reported"],
    "measurement-planned": ["context-resolved", "baseline-measured", "reported"],
    "baseline-measured": ["candidate-compared", "reported"],
    "candidate-compared": ["behavior-validated", "reported"],
    "behavior-validated": ["reported"],
    reported: [],
    blocked: [],
    inconclusive: [],
    unavailable: [],
    cancelled: [],
    failed: [],
  };
  return transitions[from].includes(to);
}

function investigationDirectory(dataRoot: string, id: string): string {
  if (!/^inv_[a-f0-9]{16}$/.test(id)) throw new Error("Invalid investigation ID.");
  return join(dataRoot, "investigations", id);
}

function digestBundle(bundle: InvestigationBundleV2): string {
  return createHash("sha256").update(stableJson(bundle)).digest("hex");
}

function digestCommit(commit: InvestigationCommitV1): string {
  return createHash("sha256")
    .update(`${stableJson(commit)}\n`)
    .digest("hex");
}

function isCommitInput(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === "smokinggun.investigation-commit.v1"
  );
}

function parseCommit(input: unknown): InvestigationCommitV1 {
  if (typeof input === "object" && input !== null && "schemaVersion" in input) {
    const candidate = input as Record<string, unknown>;
    if (candidate.schemaVersion === "smokinggun.investigation-commit.v1") {
      const fields = Object.keys(candidate).sort().join("\0");
      if (fields !== ["bundle", "parentDigest", "schemaVersion"].sort().join("\0"))
        throw new Error("Investigation commit contains unsupported fields.");
      const parentDigest = candidate.parentDigest;
      if (parentDigest !== null && (typeof parentDigest !== "string" || !/^[a-f0-9]{64}$/.test(parentDigest)))
        throw new Error("Investigation commit parent digest is invalid.");
      return {
        schemaVersion: "smokinggun.investigation-commit.v1",
        parentDigest,
        bundle: Protocol.investigation.parse(candidate.bundle),
      };
    }
  }
  const bundle = Protocol.investigation.parse(input);
  return {schemaVersion: "smokinggun.investigation-commit.v1", parentDigest: null, bundle};
}

async function writeImmutableSnapshot(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(path, bytes, {flag: "wx"});
    return;
  } catch (cause: unknown) {
    if (!isErrno(cause, "EEXIST")) throw cause;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    () => undefined,
  );
  if (handle === undefined) throw new Error("Existing investigation snapshot is not a readable regular file.");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== bytes.byteLength)
      throw new Error("Existing investigation snapshot does not match its content digest.");
    const existing = await handle.readFile();
    if (!existing.equals(bytes)) throw new Error("Existing investigation snapshot does not match its content digest.");
  } finally {
    await handle.close();
  }
}

async function acquireUpdateLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, ".update.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      let writeFailure: unknown;
      try {
        await handle.writeFile(stableJson({pid: process.pid, token, createdAt: Date.now()}));
        await handle.sync();
      } catch (cause: unknown) {
        writeFailure = cause;
      } finally {
        await handle.close();
      }
      if (writeFailure !== undefined) {
        await unlink(path).catch(() => undefined);
        throw writeFailure;
      }
      return async () => {
        const owner = await readOptional(path);
        if (owner !== undefined && owner.includes(token)) await unlink(path).catch(() => undefined);
      };
    } catch (cause: unknown) {
      if (!isErrno(cause, "EEXIST")) throw cause;
      if (attempt === 1 || !(await recoverAbandonedLock(path)))
        throw new Error("Investigation update conflict: another writer owns the latest pointer.");
    }
  }
  throw new Error("Investigation update conflict: could not acquire the latest-pointer lock.");
}

async function recoverAbandonedLock(path: string): Promise<boolean> {
  let input: string | undefined;
  try {
    input = await readOptional(path);
  } catch (cause: unknown) {
    if (!isInvalidUtf8Error(cause)) throw cause;
  }
  const info = await stat(path).catch(() => undefined);
  let pid: number | undefined;
  if (input !== undefined)
    try {
      const parsed = JSON.parse(input) as {pid?: unknown};
      if (typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid)) pid = parsed.pid;
    } catch {
      // A writer may still be filling the newly created lock file.
    }
  if (pid !== undefined && isProcessAlive(pid)) return false;
  if (pid === undefined && (info === undefined || Date.now() - info.mtimeMs < 30_000)) return false;
  const quarantine = `${path}.abandoned.${randomUUID()}`;
  try {
    await rename(path, quarantine);
    await rm(quarantine, {force: true});
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (cause: unknown) => {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    },
  );
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024 * 1024)
      throw new Error(`Investigation store entry ${path} is not a bounded regular file.`);
    return decodeUtf8Bytes(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}
