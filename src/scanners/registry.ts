import {scannerId, scannerVersion} from "./structural.js";
import type {ExternalScannerDescriptor} from "./external.js";

type ScannerDescriptorBase = {
  readonly id: string;
  readonly version: string;
  readonly kind: "built-in" | "adapter";
  readonly capabilities: ReadonlyArray<string>;
};

export type ScannerDescriptor =
  | (ScannerDescriptorBase & {readonly availability: "available"})
  | (ScannerDescriptorBase & {readonly availability: "unavailable" | "invalid"; readonly reason: string});

/** Return the installed scanner capabilities without probing the network. */
export function listScanners(
  external: ReadonlyArray<ExternalScannerDescriptor> = [],
): ReadonlyArray<ScannerDescriptor> {
  return [
    {
      id: scannerId,
      version: scannerVersion,
      kind: "built-in",
      capabilities: ["structural-complexity", "multi-language", "deterministic-json"],
      availability: "available",
    },
    {
      id: "footgun.typescript-semantic",
      version: "1.0.0",
      kind: "built-in",
      capabilities: ["symbols", "types", "calls"],
      availability: "available",
    },
    {
      id: "footgun.python-semantic",
      version: "1.0.0",
      kind: "built-in",
      capabilities: ["interpreter-free", "collection-facts", "syntax-data-flow"],
      availability: "available",
    },
    {
      id: "footgun.tree-sitter",
      version: "0.26.11",
      kind: "built-in",
      capabilities: ["syntax-aware", "parse-coverage", "14-pinned-grammars"],
      availability: "available",
    },
    {
      id: "footgun.sarif-import",
      version: "1.0.0",
      kind: "adapter",
      capabilities: ["sarif-import", "third-party-provenance"],
      availability: "available",
    },
    ...external,
  ];
}
