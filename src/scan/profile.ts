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
  const segments = normalized.split("/");
  if (segments.slice(0, -1).some((segment) => auxiliaryDirectoryNames.has(segment.toLowerCase()))) return true;
  const fileName = segments.at(-1) ?? "";
  const extension = fileName.match(/\.[^.]+$/u)?.[0] ?? "";
  const stem = extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
  return (
    /^(?:test|spec)(?:[-_.]|[A-Z]|$)/iu.test(stem) ||
    /(?:^|[-_.])(?:test|spec)s?$/iu.test(stem) ||
    /(?:Test|Spec)s?$/u.test(stem)
  );
}
