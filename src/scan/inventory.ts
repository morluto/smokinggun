import {createHash} from "node:crypto";
import {relative} from "node:path";
import {readdir} from "node:fs/promises";
import type {RepositoryInventoryV1} from "../protocol/index.js";
import {comparePortable, portablePath} from "../paths.js";
import {stableJson} from "../serialization.js";
import {sourceLanguageForExtension} from "../scanners/structural-finding.js";

const manifestNames: Readonly<Record<string, string>> = {
  "package.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "Cargo.toml": "cargo",
  "go.mod": "go",
  "pom.xml": "maven",
  "build.gradle": "gradle",
  "build.gradle.kts": "gradle",
  Gemfile: "bundler",
  "composer.json": "composer",
  "Package.swift": "swift",
  "CMakeLists.txt": "cmake",
};

export async function buildRepositoryInventory(
  root: string,
  sourceFiles: ReadonlyArray<string>,
  ignored: ReadonlyArray<string>,
): Promise<RepositoryInventoryV1> {
  const relativeFiles = sourceFiles.map((file) => portablePath(relative(root, file))).sort(comparePortable);
  const languageCounts = new Map<string, {files: number; extensions: Set<string>}>();
  for (const file of relativeFiles) {
    const extension = extensionOf(file);
    const language = sourceLanguageForExtension(extension);
    if (language === undefined) continue;
    const current = languageCounts.get(language) ?? {files: 0, extensions: new Set<string>()};
    current.files += 1;
    current.extensions.add(extension);
    languageCounts.set(language, current);
  }
  const rootEntries = await readdir(root, {withFileTypes: true}).catch(() => []);
  const manifests: string[] = [];
  const packageManagers = new Set<string>();
  for (const entry of rootEntries) {
    const manager = manifestNames[entry.name];
    if (manager === undefined || !entry.isFile()) continue;
    manifests.push(entry.name);
    packageManagers.add(manager);
  }
  const tests = relativeFiles.filter((file) =>
    /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|\.)|(?:\.test|\.spec)\.[^.]+$/i.test(file),
  );
  const benchmarks = relativeFiles.filter((file) =>
    /(?:^|\/)(?:bench|benchmark|benchmarks)(?:\/|\.)|(?:\.bench|\.benchmark)\.[^.]+$/i.test(file),
  );
  const generated = relativeFiles.filter((file) => /(?:^|\/)(?:generated|gen|dist|build|coverage)(?:\/|$)/i.test(file));
  const valueWithoutDigest = {
    schemaVersion: "smokinggun.repository-inventory.v1" as const,
    languages: [...languageCounts.entries()]
      .sort(([left], [right]) => comparePortable(left, right))
      .map(([language, value]) => ({
        language,
        files: value.files,
        extensions: [...value.extensions].sort(comparePortable),
      })),
    manifests: manifests.sort(comparePortable),
    packageManagers: [...packageManagers].sort(comparePortable),
    tests: tests.sort(comparePortable),
    benchmarks: benchmarks.sort(comparePortable),
    generated: generated.sort(comparePortable),
    ignored: [...ignored].sort(comparePortable),
  };
  return {...valueWithoutDigest, digest: createHash("sha256").update(stableJson(valueWithoutDigest)).digest("hex")};
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}
