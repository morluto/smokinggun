import {expect, it} from "vitest";
import {scanPythonSemantic} from "./python-semantic.js";

it("tracks collection assignments within lexical scope and through reassignment", async () => {
  const result = await scanPythonSemantic(
    "scope.py",
    [
      "values = []",
      "def indexed(items):",
      "    values = set(items)",
      "    for item in items:",
      "        if item in values:",
      "            pass",
      "def linear(items):",
      "    values = set(items)",
      "    values = list(items)",
      "    for item in items:",
      "        if item in values:",
      "            pass",
    ].join("\n"),
  );
  expect(result.coverage.status).toBe("complete");
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).toMatchObject({location: {startLine: 11}, confidence: "type-informed"});
});
