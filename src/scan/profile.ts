export const scanProfiles = ["runtime", "all"] as const;

export type ScanProfile = (typeof scanProfiles)[number];

const auxiliaryDirectoryNames = new Set([
  "__tests__",
  "doc",
  "docs",
  "documentation",
  "example",
  "examples",
  "fixture",
  "fixtures",
  "sample",
  "samples",
  "spec",
  "specs",
  "test",
  "tests",
]);

const testDirectoryNames = new Set(["__tests__", "spec", "specs", "test", "tests"]);

function sourceFileStem(path: string): string {
  const fileName = path.split("/").at(-1) ?? "";
  const extension = fileName.match(/\.[^.]+$/u)?.[0] ?? "";
  return extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
}

/** Whether a root-relative path names a test source file. */
export function isTestSourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.slice(0, -1).some((segment) => testDirectoryNames.has(segment.toLowerCase()))) return true;
  const stem = sourceFileStem(normalized);
  const prefix = /^(?:test|spec)/iu.exec(stem)?.[0];
  return (
    /^(?:test|spec)(?:[-_.]|$)/iu.test(stem) ||
    (prefix !== undefined && /^[A-Z]/u.test(stem.slice(prefix.length))) ||
    /(?:^|[-_.])(?:test|spec)s?$/iu.test(stem) ||
    /(?:Test|Spec)s?(?:Case)?$/u.test(stem)
  );
}

/** Whether a root-relative path is inside an auxiliary source directory. */
export function isAuxiliarySourceDirectory(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => auxiliaryDirectoryNames.has(segment.toLowerCase()));
}

/** Whether a root-relative source path is auxiliary to the shipped runtime. */
export function isAuxiliarySourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return (
    segments.slice(0, -1).some((segment) => auxiliaryDirectoryNames.has(segment.toLowerCase())) ||
    isTestSourcePath(normalized)
  );
}
