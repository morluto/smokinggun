import {resolve} from "node:path";
import {describe, expect, it} from "vitest";
import {parseWithTreeSitter, probeTreeSitter} from "./tree-sitter-runtime.js";

describe("pinned Tree-sitter runtime", () => {
  it("loads the shipped grammar set", async () => {
    const capability = await probeTreeSitter();
    expect(capability.runtime).toBe("available");
    expect(capability.grammars).toBe("available");
    expect(capability.languages).toHaveLength(14);
  });

  it("reports syntax coverage rather than treating parse errors as success", async () => {
    const valid = await parseWithTreeSitter(
      resolve("fixtures/corpus/typescript/nested-scan.ts"),
      "const value: string = 'ok';",
    );
    const invalid = await parseWithTreeSitter("invalid.py", "def broken(:\n  return 1\n");
    expect(valid.status).toBe("complete");
    expect(invalid.status).toBe("partial");
  });

  it("parses Rust raw identifiers used as bindings and references", async () => {
    const coverage = await parseWithTreeSitter(
      "raw-identifier.rs",
      "fn main() { let raw = String::new(); let _borrowed = &raw; }",
    );

    expect(coverage).toEqual({language: "rust", status: "complete"});
  });
});
