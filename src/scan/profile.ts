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

/** Whether a root-relative source path is auxiliary to the shipped runtime. */
export function isAuxiliarySourcePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.toLowerCase().split("/");
  if (segments.slice(0, -1).some((segment) => auxiliaryDirectoryNames.has(segment))) return true;
  const fileName = segments.at(-1) ?? "";
  return /(?:^|\.)(?:test|spec)\.[^.]+$/i.test(fileName);
}
