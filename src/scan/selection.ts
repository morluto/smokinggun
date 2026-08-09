import {extname, isAbsolute} from "node:path";
import type {ProblemV1} from "../protocol/index.js";
import {pythonSemanticScannerId, pythonSemanticScannerVersion} from "../scanners/python-semantic.js";
import {scannerId, scannerVersion} from "../scanners/structural.js";
import {semanticScannerId, semanticScannerVersion} from "../scanners/typescript-semantic.js";

export type BuiltInScanBackend = "structural" | "typescript-semantic" | "python-semantic";

export type BuiltInScannerDescriptor = {
  readonly id: string;
  readonly version: string;
  readonly capabilities: ReadonlyArray<string>;
};

type ScannerDefinition = BuiltInScannerDescriptor & {
  readonly backend: BuiltInScanBackend;
  readonly aliases: ReadonlyArray<string>;
};

const treeSitterScannerId = "footgun.tree-sitter";
const treeSitterScannerVersion = "0.26.11";

const scannerDefinitions: ReadonlyArray<ScannerDefinition> = [
  {
    id: scannerId,
    version: scannerVersion,
    capabilities: ["structural-complexity", "multi-language", "deterministic-json"],
    backend: "structural",
    aliases: ["structural"],
  },
  {
    id: semanticScannerId,
    version: semanticScannerVersion,
    capabilities: ["symbols", "types", "calls"],
    backend: "typescript-semantic",
    aliases: ["typescript", "typescript-semantic"],
  },
  {
    id: pythonSemanticScannerId,
    version: pythonSemanticScannerVersion,
    capabilities: ["interpreter-free", "collection-facts", "syntax-data-flow"],
    backend: "python-semantic",
    aliases: ["python", "python-semantic"],
  },
  {
    id: treeSitterScannerId,
    version: treeSitterScannerVersion,
    capabilities: ["syntax-aware", "parse-coverage", "14-pinned-grammars"],
    backend: "structural",
    aliases: ["tree-sitter"],
  },
];

const supportedLanguages = new Set([
  "c",
  "cpp",
  "csharp",
  "go",
  "java",
  "javascript",
  "kotlin",
  "php",
  "python",
  "ruby",
  "rust",
  "swift",
  "typescript",
]);
const supportedExtensions = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".cjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

export type ScannerSelection =
  | {readonly _tag: "AutomaticScannerSelection"}
  | {
      readonly _tag: "ExplicitScannerSelection";
      readonly backends: ReadonlySet<BuiltInScanBackend>;
      readonly adapters: ReadonlySet<string>;
    };

export type ScanScope =
  | {readonly _tag: "EntireScanRoot"}
  | {readonly _tag: "FilteredScanRoot"; readonly filters: ReadonlyArray<OnlyFilter>};

type OnlyFilter =
  | {readonly _tag: "LanguageFilter"; readonly language: string}
  | {readonly _tag: "ExtensionFilter"; readonly extension: string}
  | {readonly _tag: "PathFilter"; readonly path: string};

/** List selectable built-in scanner capabilities from the same definitions used for selection. */
export function listBuiltInScanners(): ReadonlyArray<BuiltInScannerDescriptor> {
  return scannerDefinitions.map(({backend: _backend, aliases: _aliases, ...descriptor}) => descriptor);
}

/** Construct the selection used when the caller did not restrict scanner backends. */
export function automaticScannerSelection(): ScannerSelection {
  return {_tag: "AutomaticScannerSelection"};
}

/** Construct the scope used when the caller did not restrict source paths. */
export function entireScanRoot(): ScanScope {
  return {_tag: "EntireScanRoot"};
}

/** Parse command-line scanner values before they reach repository scanning. */
export function parseScannerSelection(
  values: ReadonlyArray<string> | undefined,
  configuredAdapterIds: ReadonlyArray<string>,
): ScannerSelection | ProblemV1 {
  const requested =
    values?.flatMap((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ) ?? [];
  if (requested.length === 0) return automaticScannerSelection();
  if (requested.includes("auto")) {
    if (requested.length === 1) return automaticScannerSelection();
    return invalidSelection("auto cannot be combined with explicit scanner IDs.");
  }
  const backends = new Set<BuiltInScanBackend>();
  const adapters = new Set<string>();
  const configured = new Set(configuredAdapterIds);
  const unknown: string[] = [];
  for (const id of requested) {
    const definition = scannerDefinitions.find((candidate) => candidate.id === id || candidate.aliases.includes(id));
    if (definition !== undefined) {
      backends.add(definition.backend);
      continue;
    }
    if (configured.has(id)) {
      adapters.add(id);
      continue;
    }
    unknown.push(id);
  }
  if (unknown.length > 0)
    return invalidSelection(
      `Unknown scanner ID${unknown.length === 1 ? "" : "s"}: ${[...new Set(unknown)].join(", ")}.`,
    );
  return {_tag: "ExplicitScannerSelection", backends, adapters};
}

/** Parse `--only` values into root-relative, supported source filters. */
export function parseScanScope(values: ReadonlyArray<string> | undefined): ScanScope | ProblemV1 {
  const rawFilters =
    values?.flatMap((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ) ?? [];
  if (rawFilters.length === 0) return entireScanRoot();
  if (rawFilters.includes(".")) {
    if (rawFilters.length === 1) return entireScanRoot();
    return invalidScope(". cannot be combined with other --only filters.");
  }
  const filters: OnlyFilter[] = [];
  for (const value of rawFilters) {
    if (value.startsWith("language:")) {
      const language = value.slice("language:".length).toLowerCase();
      if (!supportedLanguages.has(language)) return invalidScope(`Unsupported language filter: ${value}.`);
      filters.push({_tag: "LanguageFilter", language});
      continue;
    }
    if (value.startsWith(".")) {
      const extension = value.toLowerCase();
      if (!supportedExtensions.has(extension)) return invalidScope(`Unsupported extension filter: ${value}.`);
      filters.push({_tag: "ExtensionFilter", extension});
      continue;
    }
    if (isAbsolute(value) || value.split(/[\\/]/).includes(".."))
      return invalidScope(`Path filters must stay within the scan root: ${value}.`);
    filters.push({_tag: "PathFilter", path: value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")});
  }
  return {_tag: "FilteredScanRoot", filters};
}

/** Whether the parsed selection requires a built-in backend. */
export function runsBuiltInScanner(selection: ScannerSelection, backend: BuiltInScanBackend): boolean {
  return selection._tag === "AutomaticScannerSelection" || selection.backends.has(backend);
}

/** Whether the parsed selection requires an external adapter. */
export function runsAdapter(selection: ScannerSelection, adapterId: string): boolean {
  return selection._tag === "AutomaticScannerSelection" || selection.adapters.has(adapterId);
}

/** Whether the selection explicitly required a backend even when no compatible source files exist. */
export function explicitlyRequiresScanner(selection: ScannerSelection, backend: BuiltInScanBackend): boolean {
  return selection._tag === "ExplicitScannerSelection" && selection.backends.has(backend);
}

/** Match a discovered file against the parsed root-relative scope. */
export function matchesScanScope(scope: ScanScope, rootRelativePath: string): boolean {
  if (scope._tag === "EntireScanRoot") return true;
  const path = rootRelativePath.replaceAll("\\", "/");
  const extension = extname(path).toLowerCase();
  const language = languageForExtension(extension);
  return scope.filters.some((filter) => {
    switch (filter._tag) {
      case "LanguageFilter":
        return language === filter.language;
      case "ExtensionFilter":
        return extension === filter.extension;
      case "PathFilter":
        return path === filter.path || path.startsWith(`${filter.path}/`);
    }
  });
}

/** Whether an explicit scope selected no analyzable files or skipped source links. */
export function hasUnmatchedExplicitScope(scope: ScanScope, selectedCount: number): boolean {
  return scope._tag === "FilteredScanRoot" && selectedCount === 0;
}

function languageForExtension(extension: string): string {
  if (extension === ".py") return "python";
  if ([".ts", ".tsx"].includes(extension)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "javascript";
  return extension.slice(1);
}

function invalidSelection(detail: string): ProblemV1 {
  return {
    schemaVersion: "footgun.problem.v1",
    code: "invalid-scanner-selection",
    message: "The scanner selection is invalid.",
    detail,
    recovery: "Run `smokinggun scanners list` and select one or more listed scanner IDs.",
  };
}

function invalidScope(detail: string): ProblemV1 {
  return {
    schemaVersion: "footgun.problem.v1",
    code: "invalid-scan-scope",
    message: "The --only filter is invalid.",
    detail,
    recovery: "Use a supported language, extension, or scan-root-relative path.",
  };
}
