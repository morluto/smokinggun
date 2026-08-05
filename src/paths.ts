import {isAbsolute, posix, relative, sep} from "node:path";

/** Normalize a local path for portable reports. */
export function portablePath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/"));
}

/** Compare portable paths and other report keys by code-unit order. */
export function comparePortable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Return whether a resolved candidate is inside a resolved root. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep);
}
