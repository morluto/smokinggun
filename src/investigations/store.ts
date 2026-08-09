import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
  Protocol,
  type EvidenceRecordV2,
  type InvestigationBundleV2,
  type InvestigationPointerV1,
} from "../protocol/index.js";
import {comparePortable} from "../paths.js";
import {stableJson} from "../serialization.js";
import {writeFileAtomically} from "../files.js";

type StoredInvestigation = {
  readonly bundle: InvestigationBundleV2;
  readonly digest: string;
};

const reportAttachableStates = new Set<InvestigationBundleV2["state"]>([
  "scanned",
  "context-resolved",
  "measurement-planned",
  "baseline-measured",
  "candidate-compared",
  "behavior-validated",
]);

const baselineMeasurementSourceStates = new Set<InvestigationBundleV2["state"]>([
  "scanned",
  "context-resolved",
  "measurement-planned",
]);

const contextSourceStates = new Set<InvestigationBundleV2["state"]>([
  "scanned",
  "context-resolved",
  "measurement-planned",
]);

export function canAttachReport(bundle: InvestigationBundleV2): boolean {
  return reportAttachableStates.has(bundle.state);
}

/** Whether this bundle can transition to a retained baseline measurement. */
export function canRecordBaselineMeasurement(bundle: InvestigationBundleV2): boolean {
  return baselineMeasurementSourceStates.has(bundle.state);
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
    const bundle = Protocol.investigation.parse(snapshotInput);
    if (digestBundle(bundle) !== pointer.bundleDigest)
      throw new Error(`Investigation snapshot ${pointer.bundleDigest} does not match its content digest.`);
    return {bundle, digest: pointer.bundleDigest};
  }
  const bundleText = await readOptional(join(directory, "bundle.json"));
  if (bundleText === undefined) return undefined;
  const bundleInput: unknown = JSON.parse(bundleText);
  const bundle = Protocol.investigation.parse(bundleInput);
  return {bundle, digest: digestBundle(bundle)};
}

/** Load an existing investigation or fail before a command performs dependent work. */
export async function requireLatestInvestigation(dataRoot: string, id: string): Promise<StoredInvestigation> {
  const investigation = await loadLatestInvestigation(dataRoot, id);
  if (investigation === undefined) throw new Error(`Investigation ${id} does not exist.`);
  return investigation;
}

/** Validate untrusted bundle input before storing an immutable snapshot. */
export async function recordInvestigationSnapshot(dataRoot: string, bundleInput: unknown): Promise<string> {
  return recordParsedInvestigationSnapshot(dataRoot, Protocol.investigation.parse(bundleInput));
}

/** Store a bundle that has already crossed the investigation schema boundary. */
export async function recordParsedInvestigationSnapshot(
  dataRoot: string,
  bundle: InvestigationBundleV2,
): Promise<string> {
  const latest = await loadLatestInvestigation(dataRoot, bundle.id);
  if (
    latest !== undefined &&
    latest.bundle.state !== bundle.state &&
    !isAllowedTransition(latest.bundle.state, bundle.state)
  ) {
    throw new Error(`Invalid investigation transition from ${latest.bundle.state} to ${bundle.state}.`);
  }
  const digest = digestBundle(bundle);
  const directory = investigationDirectory(dataRoot, bundle.id);
  const snapshots = join(directory, "snapshots");
  await mkdir(snapshots, {recursive: true});
  const snapshotPath = join(snapshots, `${digest}.json`);
  try {
    await writeFile(snapshotPath, `${JSON.stringify(bundle, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  } catch (cause: unknown) {
    if (!isErrno(cause, "EEXIST")) throw cause;
  }
  const pointer: InvestigationPointerV1 = {
    schemaVersion: "footgun.investigation-pointer.v1",
    bundleDigest: digest,
    updatedAt: new Date().toISOString(),
  };
  const pointerPath = join(directory, "latest.json");
  await writeFileAtomically(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  return digest;
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

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause: unknown) {
    if (isErrno(cause, "ENOENT")) return undefined;
    throw cause;
  }
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}
