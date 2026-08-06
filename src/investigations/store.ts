import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Protocol, type InvestigationBundleV1, type InvestigationPointerV1} from "../protocol/index.js";
import {stableJson} from "../serialization.js";

type StoredInvestigation = {
  readonly bundle: InvestigationBundleV1;
  readonly digest: string;
};

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
    return {bundle, digest: pointer.bundleDigest};
  }
  const bundleText = await readOptional(join(directory, "bundle.json"));
  if (bundleText === undefined) return undefined;
  const bundleInput: unknown = JSON.parse(bundleText);
  const bundle = Protocol.investigation.parse(bundleInput);
  return {bundle, digest: digestBundle(bundle)};
}

/** Store a content-addressed bundle snapshot and atomically advance its pointer. */
export async function recordInvestigationSnapshot(dataRoot: string, bundle: InvestigationBundleV1): Promise<string> {
  const parsed = Protocol.investigation.parse(bundle);
  const latest = await loadLatestInvestigation(dataRoot, parsed.id);
  if (
    latest !== undefined &&
    latest.bundle.state !== parsed.state &&
    !isAllowedTransition(latest.bundle.state, parsed.state)
  ) {
    throw new Error(`Invalid investigation transition from ${latest.bundle.state} to ${parsed.state}.`);
  }
  const digest = digestBundle(parsed);
  const directory = investigationDirectory(dataRoot, parsed.id);
  const snapshots = join(directory, "snapshots");
  await mkdir(snapshots, {recursive: true});
  const snapshotPath = join(snapshots, `${digest}.json`);
  try {
    await writeFile(snapshotPath, `${JSON.stringify(parsed, null, 2)}\n`, {encoding: "utf8", flag: "wx"});
  } catch (cause: unknown) {
    if (!isErrno(cause, "EEXIST")) throw cause;
  }
  const pointer: InvestigationPointerV1 = {
    schemaVersion: "footgun.investigation-pointer.v1",
    bundleDigest: digest,
    updatedAt: new Date().toISOString(),
  };
  const pointerPath = join(directory, "latest.json");
  const temporary = `${pointerPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  await rename(temporary, pointerPath);
  return digest;
}

const terminalStates = new Set<InvestigationBundleV1["state"]>([
  "blocked",
  "inconclusive",
  "unavailable",
  "cancelled",
  "failed",
]);

function isAllowedTransition(from: InvestigationBundleV1["state"], to: InvestigationBundleV1["state"]): boolean {
  if (terminalStates.has(from)) return false;
  if (terminalStates.has(to)) return true;
  const transitions: Record<InvestigationBundleV1["state"], ReadonlyArray<InvestigationBundleV1["state"]>> = {
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

function digestBundle(bundle: InvestigationBundleV1): string {
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
