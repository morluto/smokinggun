import {describe, expect, it} from "vitest";
import {scanSource} from "./structural.js";

describe("structural scanner", () => {
  it("reports nested iteration and ignores comments and strings", () => {
    const result = scanSource("fixture.ts", `const text = "for (const item of items)";\n// while (true) {}\nfor (const item of items) {\n  values.filter((value) => value > item);\n}`);
    expect(result.parseStatus).toBe("complete");
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["nested-or-callback-loop", "repeated-scan"]);
  });

  it("deduplicates a finding with the same stable location and rule", () => {
    const result = scanSource("fixture.py", "for item in items:\n    for other in items:\n        if other in values:\n            sorted(values)\n");
    const ids = result.findings.map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.findings.some((finding) => finding.ruleId === "membership-in-loop")).toBe(true);
    expect(result.findings.some((finding) => finding.ruleId === "sort-in-loop")).toBe(true);
  });

  it("marks an unmatched block as partial coverage", () => {
    const result = scanSource("fixture.ts", "for (const item of items) {\n  work(item);\n");
    expect(result.parseStatus).toBe("partial");
  });
});
