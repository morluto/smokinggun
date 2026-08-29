import {listBuiltInScanners} from "../scan/selection.js";

type ScannerDescriptorBase = {
  readonly id: string;
  readonly version: string;
  readonly kind: "built-in";
  readonly capabilities: ReadonlyArray<string>;
};

export type ScannerDescriptor =
  | (ScannerDescriptorBase & {readonly availability: "available"})
  | (ScannerDescriptorBase & {readonly availability: "unavailable" | "invalid"; readonly reason: string});

/** Return the installed scanner capabilities without probing the network. */
export function listScanners(): ReadonlyArray<ScannerDescriptor> {
  return listBuiltInScanners().map((scanner): ScannerDescriptor =>
    scanner.availability === "available"
      ? {
          id: scanner.id,
          version: scanner.version,
          capabilities: scanner.capabilities,
          kind: "built-in",
          availability: "available",
        }
      : {
          id: scanner.id,
          version: scanner.version,
          capabilities: scanner.capabilities,
          kind: "built-in",
          availability: "unavailable",
          reason: scanner.reason ?? "The scanner is unavailable in this build.",
        },
  );
}
