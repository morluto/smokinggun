import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {relative, resolve} from "node:path";
import {comparePortable, isWithinRoot, portablePath} from "../paths.js";
import {stableJson} from "../serialization.js";

/** Resource bounds applied while capturing source bytes for one scan. */
export type SourceCaptureLimits = {
  readonly maxFiles: number;
  readonly maxDirectories: number;
  readonly maxDepth: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
};

/** Exact source bytes retained for analysis under their content digest. */
type CapturedSourceFile = {
  readonly _tag: "captured";
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly text: string;
};

/** A requested source path that could not enter the immutable snapshot. */
export type UnavailableSourceFile = {
  readonly _tag: "unavailable";
  readonly path: string;
  readonly reason:
    | "file-count-limit"
    | "file-size-limit"
    | "total-size-limit"
    | "invalid-utf8"
    | "outside-root"
    | "read-failed";
};

/** One host-requested source path and its capture outcome. */
type SourceFileCapture = CapturedSourceFile | UnavailableSourceFile;

/** Immutable manifest and retained source values consumed by scanners. */
export type SourceSnapshot = {
  readonly digest: string;
  readonly files: ReadonlyArray<SourceFileCapture>;
  readonly capturedFiles: ReadonlyArray<CapturedSourceFile>;
  readonly requestedFileCount: number;
  readonly capturedFileCount: number;
  readonly capturedBytes: number;
  readonly isComplete: boolean;
};

/** Conservative default bounds for a local static scan. */
export const defaultSourceCaptureLimits: SourceCaptureLimits = {
  maxFiles: 100_000,
  maxDirectories: 100_000,
  maxDepth: 128,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

/**
 * Capture selected source files as exact, bounded bytes before analysis.
 *
 * The snapshot digest commits to every requested path, captured byte digest,
 * and visible omission. Paths are processed in canonical order so resource
 * bounds and the resulting identity are deterministic.
 */
export async function captureSourceSnapshot(
  root: string,
  targets: ReadonlyArray<string>,
  limits: SourceCaptureLimits = defaultSourceCaptureLimits,
  options: {readonly signal?: AbortSignal} = {},
): Promise<SourceSnapshot> {
  requireValidLimits(limits);
  const resolvedRoot = resolve(root);
  const orderedTargets = [...targets].sort((left, right) =>
    comparePortable(portablePath(relative(resolvedRoot, left)), portablePath(relative(resolvedRoot, right))),
  );
  const files: SourceFileCapture[] = [];
  const capturedFiles: CapturedSourceFile[] = [];
  let capturedBytes = 0;

  // Sequential acquisition is deliberate: the cumulative byte budget and
  // deterministic first-N policy must not depend on I/O completion order.
  for (const [index, target] of orderedTargets.entries()) {
    options.signal?.throwIfAborted();
    const resolvedTarget = resolve(target);
    const path = portablePath(relative(resolvedRoot, resolvedTarget));
    if (!isWithinRoot(resolvedRoot, resolvedTarget) || path === ".") {
      files.push({_tag: "unavailable", path, reason: "outside-root"});
      continue;
    }
    if (index >= limits.maxFiles) {
      files.push({_tag: "unavailable", path, reason: "file-count-limit"});
      continue;
    }
    const captured = await captureFile(resolvedTarget, path, capturedBytes, limits);
    files.push(captured);
    if (captured._tag === "captured") {
      capturedFiles.push(captured);
      capturedBytes += captured.size;
    }
  }

  const manifest = files.map((file) =>
    file._tag === "captured"
      ? {path: file.path, state: file._tag, digest: file.digest, size: file.size}
      : {path: file.path, state: file._tag, reason: file.reason},
  );
  const digest = createHash("sha256")
    .update("smokinggun.source-snapshot.v1\0")
    .update(stableJson(manifest))
    .digest("hex");
  return {
    digest,
    files,
    capturedFiles,
    requestedFileCount: files.length,
    capturedFileCount: capturedFiles.length,
    capturedBytes,
    isComplete: files.every((file) => file._tag === "captured"),
  };
}

async function captureFile(
  absolutePath: string,
  path: string,
  capturedBytes: number,
  limits: SourceCaptureLimits,
): Promise<SourceFileCapture> {
  let handle;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return {_tag: "unavailable", path, reason: "read-failed"};
    if (info.size > limits.maxFileBytes) return {_tag: "unavailable", path, reason: "file-size-limit"};
    if (capturedBytes + info.size > limits.maxTotalBytes)
      return {_tag: "unavailable", path, reason: "total-size-limit"};
    const bytes = await handle.readFile();
    if (bytes.byteLength > limits.maxFileBytes) return {_tag: "unavailable", path, reason: "file-size-limit"};
    if (capturedBytes + bytes.byteLength > limits.maxTotalBytes)
      return {_tag: "unavailable", path, reason: "total-size-limit"};
    let text: string;
    try {
      text = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    } catch {
      return {_tag: "unavailable", path, reason: "invalid-utf8"};
    }
    return {
      _tag: "captured",
      path,
      digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      bytes,
      text,
    };
  } catch {
    return {_tag: "unavailable", path, reason: "read-failed"};
  } finally {
    await handle?.close();
  }
}

function requireValidLimits(limits: SourceCaptureLimits): void {
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles <= 0 ||
    !Number.isSafeInteger(limits.maxDirectories) ||
    limits.maxDirectories <= 0 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes <= 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes <= 0
  )
    throw new Error("Source capture limits must be positive safe integers.");
}
