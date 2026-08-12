import {createHash} from "node:crypto";
import type {ScanReportV2} from "../protocol/index.js";
import {stableJson} from "../serialization.js";

/** Canonical exact bytes and content identity for a validated scan report. */
export type EncodedScanArtifact = {
  readonly bytes: Uint8Array;
  readonly digest: string;
};

/** Encode a scan report once for content-addressed persistence and evidence binding. */
export function encodeScanArtifact(report: ScanReportV2): EncodedScanArtifact {
  const bytes = Buffer.from(`${stableJson(report)}\n`, "utf8");
  return {bytes, digest: createHash("sha256").update(bytes).digest("hex")};
}
