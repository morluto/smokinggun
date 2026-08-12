import {describe, expect, it} from "vitest";
import {parseScannerSelection, parseScanScope} from "./selection.js";

describe("scan selection boundary", () => {
  it("parses every advertised built-in scanner ID", () => {
    for (const id of [
      "smokinggun.structural",
      "smokinggun.typescript-semantic",
      "smokinggun.python-semantic",
      "smokinggun.tree-sitter",
    ]) {
      const selection = parseScannerSelection([id], []);
      expect("schemaVersion" in selection).toBe(false);
    }
  });

  it("rejects unknown and ambiguous scanner requests before scanning", () => {
    const unknown = parseScannerSelection(["definitely-not-a-scanner"], []);
    expect(unknown).toMatchObject({code: "invalid-scanner-selection"});
    const ambiguous = parseScannerSelection(["auto", "smokinggun.structural"], []);
    expect(ambiguous).toMatchObject({code: "invalid-scanner-selection"});
  });

  it("accepts only supported scope kinds and root-relative paths", () => {
    expect(parseScanScope(["language:tyepscript"])).toMatchObject({code: "invalid-scan-scope"});
    expect(parseScanScope([".wat"])).toMatchObject({code: "invalid-scan-scope"});
    expect(parseScanScope(["/outside"])).toMatchObject({code: "invalid-scan-scope"});
    expect(parseScanScope([".", ".ts"])).toMatchObject({code: "invalid-scan-scope"});
    expect("schemaVersion" in parseScanScope(["src/scan"])).toBe(false);
  });
});
