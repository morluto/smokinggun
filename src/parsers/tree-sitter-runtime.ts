import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {Language, Parser, type Node, type Tree} from "web-tree-sitter";

export type ParserCapability = {
  readonly runtime: "available" | "unavailable";
  readonly grammars: "available" | "unavailable";
  readonly languages: ReadonlyArray<string>;
  readonly reason?: string;
};

export type ParseCoverage = {
  readonly language: string;
  readonly status: "complete" | "partial" | "unavailable";
  readonly error?: string;
};

export type TreeSitterInspection<T> = {
  readonly coverage: ParseCoverage;
  readonly value?: T;
};

const grammarRoot = fileURLToPath(new URL("../../grammars/", import.meta.url));
const runtimeWasm = createRequire(import.meta.url).resolve("web-tree-sitter/web-tree-sitter.wasm");
const grammarFiles = {
  c: "tree-sitter-c.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  cpp: "tree-sitter-cpp.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  javascript: "tree-sitter-javascript.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  php: "tree-sitter-php.wasm",
  python: "tree-sitter-python.wasm",
  ruby: "tree-sitter-ruby.wasm",
  rust: "tree-sitter-rust.wasm",
  swift: "tree-sitter-swift.wasm",
  tsx: "tree-sitter-tsx.wasm",
  typescript: "tree-sitter-typescript.wasm",
} as const;

type GrammarName = keyof typeof grammarFiles;

let initialization: Promise<void> | undefined;
const languages = new Map<GrammarName, Promise<Language>>();

/** Parse source with the pinned grammar when one is available. */
export async function parseWithTreeSitter(path: string, source: string, signal?: AbortSignal): Promise<ParseCoverage> {
  const language = languageForPath(path);
  if (language === undefined) return {language: "unknown", status: "unavailable", error: "No pinned grammar matches this file extension."};
  try {
    await initialize(signal);
    const parser = new Parser();
    let tree: Tree | null = null;
    try {
      const grammar = await loadLanguage(language);
      parser.setLanguage(grammar);
      tree = parser.parse(source, null, {
        progressCallback: () => {
          if (signal?.aborted) throw new Error("Tree-sitter parsing cancelled.");
        },
      });
      if (tree === null) return {language, status: "unavailable", error: "Tree-sitter cancelled parsing."};
      return tree.rootNode.hasError ? {language, status: "partial", error: "The grammar reported one or more syntax errors."} : {language, status: "complete"};
    } finally {
      tree?.delete();
      parser.delete();
    }
  } catch (cause: unknown) {
    return {language, status: "unavailable", error: cause instanceof Error ? cause.message : "Tree-sitter parsing failed."};
  }
}

/** Inspect a parsed tree while its native resources are owned by this module. */
export async function inspectWithTreeSitter<T>(path: string, source: string, inspect: (root: Node, language: string) => T, signal?: AbortSignal): Promise<TreeSitterInspection<T>> {
  const language = languageForPath(path);
  if (language === undefined) return {coverage: {language: "unknown", status: "unavailable", error: "No pinned grammar matches this file extension."}};
  try {
    await initialize(signal);
    const parser = new Parser();
    let tree: Tree | null = null;
    try {
      const grammar = await loadLanguage(language);
      parser.setLanguage(grammar);
      tree = parser.parse(source, null, {progressCallback: () => {
        if (signal?.aborted) throw new Error("Tree-sitter parsing cancelled.");
      }});
      if (tree === null) return {coverage: {language, status: "unavailable", error: "Tree-sitter cancelled parsing."}};
      const coverage: ParseCoverage = tree.rootNode.hasError ? {language, status: "partial", error: "The grammar reported one or more syntax errors."} : {language, status: "complete"};
      return tree.rootNode.hasError ? {coverage} : {coverage, value: inspect(tree.rootNode, language)};
    } finally {
      tree?.delete();
      parser.delete();
    }
  } catch (cause: unknown) {
    return {coverage: {language, status: "unavailable", error: cause instanceof Error ? cause.message : "Tree-sitter inspection failed."}};
  }
}

/** Probe the parser runtime and verify all shipped grammar assets and digests. */
export async function probeTreeSitter(): Promise<ParserCapability> {
  try {
    await initialize();
    const available: string[] = [];
    for (const language of Object.keys(grammarFiles)) {
      if (!isGrammarName(language)) continue;
      try {
        await loadLanguage(language);
        available.push(language);
      } catch {
        // The probe reports the unavailable language through the aggregate reason.
      }
    }
    if (available.length === 0) return {runtime: "available", grammars: "unavailable", languages: [], reason: "No pinned WASM grammar could be loaded."};
    return {runtime: "available", grammars: available.length === Object.keys(grammarFiles).length ? "available" : "unavailable", languages: available, ...(available.length === Object.keys(grammarFiles).length ? {} : {reason: "One or more pinned WASM grammars could not be loaded."})};
  } catch (cause: unknown) {
    return {runtime: "unavailable", grammars: "unavailable", languages: [], reason: cause instanceof Error ? cause.message : "Tree-sitter runtime initialization failed."};
  }
}

function initialize(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Tree-sitter initialization cancelled."));
  initialization ??= Parser.init({locateFile: () => runtimeWasm});
  return initialization;
}

function loadLanguage(language: GrammarName): Promise<Language> {
  const cached = languages.get(language);
  if (cached !== undefined) return cached;
  const path = `${grammarRoot}${grammarFiles[language]}`;
  const loaded = Language.load(path);
  languages.set(language, loaded);
  return loaded;
}

function languageForPath(path: string): GrammarName | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".c": case ".h": return "c";
    case ".cc": case ".cpp": case ".cxx": case ".hpp": case ".hh": return "cpp";
    case ".cs": return "csharp";
    case ".go": return "go";
    case ".java": return "java";
    case ".kt": case ".kts": return "kotlin";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "javascript";
    case ".php": return "php";
    case ".py": return "python";
    case ".rb": return "ruby";
    case ".rs": return "rust";
    case ".swift": return "swift";
    case ".tsx": return "tsx";
    case ".ts": return "typescript";
    default: return undefined;
  }
}

function isGrammarName(value: string): value is GrammarName {
  return Object.hasOwn(grammarFiles, value);
}

/** Compute a digest for a shipped grammar file during release verification. */
export async function grammarDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
