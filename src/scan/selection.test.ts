import {describe, expect, it} from "vitest";
import {matchesScanScope, parseScannerSelection, parseScanScope} from "./selection.js";

describe("scan selection boundary", () => {
  it("parses every advertised built-in scanner ID", () => {
    for (const id of [
      "smokinggun.structural",
      "smokinggun.typescript-semantic",
      "smokinggun.python-semantic",
      "smokinggun.tree-sitter",
    ]) {
      const selection = parseScannerSelection([id]);
      expect("schemaVersion" in selection).toBe(false);
    }
  });

  it("rejects unknown and ambiguous scanner requests before scanning", () => {
    const unknown = parseScannerSelection(["definitely-not-a-scanner"]);
    expect(unknown).toMatchObject({code: "invalid-scanner-selection"});
    const ambiguous = parseScannerSelection(["auto", "smokinggun.structural"]);
    expect(ambiguous).toMatchObject({code: "invalid-scanner-selection"});
  });

  it("accepts only supported scope kinds and root-relative paths", () => {
    expect(parseScanScope(["language:tyepscript"])).toMatchObject({code: "invalid-scan-scope"});
    expect(parseScanScope([".wat"])).toMatchObject({code: "invalid-scan-scope"});
    expect(parseScanScope(["/outside"])).toMatchObject({code: "invalid-scan-scope"});
    expect(parseScanScope([".", ".ts"])).toMatchObject({code: "invalid-scan-scope"});
    expect("schemaVersion" in parseScanScope(["src/scan"])).toBe(false);
  });

  it("matches every supported C and C++ source extension", () => {
    for (const extension of [".h", ".cc", ".cxx", ".hpp", ".hh"])
      expect("schemaVersion" in parseScanScope([extension])).toBe(false);

    const c = parseScanScope(["language:c"]);
    const cpp = parseScanScope(["language:cpp"]);
    expect("schemaVersion" in c).toBe(false);
    expect("schemaVersion" in cpp).toBe(false);
    if (!("schemaVersion" in c) && !("schemaVersion" in cpp)) {
      expect(matchesScanScope(c, "include/example.h")).toBe(true);
      for (const path of [
        "src/example.cc",
        "src/example.cpp",
        "src/example.cxx",
        "include/example.hpp",
        "include/example.hh",
      ])
        expect(matchesScanScope(cpp, path)).toBe(true);
    }
  });
});
