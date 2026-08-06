import {comparePortable} from "./paths.js";

/** Serialize JSON-compatible data with deterministic object-key ordering. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Cannot serialize undefined JSON data.");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => comparePortable(left, right));
  return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + stableJson(entry)).join(",") + "}";
}
