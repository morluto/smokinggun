import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {expect, it} from "vitest";
import {scanTypeScript, scanTypeScriptSnapshot} from "./typescript-semantic.js";

it("records compiler-backed context and typed collection findings", async () => {
  const root = resolve("fixtures/corpus/typescript");
  const file = resolve(root, "nested-scan.ts");
  const result = await scanTypeScript(root, [file]);
  const source = await readFile(file, "utf8");
  expect(source).toContain("items.includes");
  expect(result.state).toBe("complete");
  expect(result.index?.coverage.filesIndexed).toBe(1);
  expect(result.index?.definitions.some((definition) => definition.name === "collect")).toBe(true);
  expect(result.findings.some((finding) => finding.confidence === "type-informed")).toBe(true);
});

it("represents a source set without TypeScript files as unavailable before compiler analysis", async () => {
  const root = resolve("fixtures/corpus/python");
  const result = await scanTypeScript(root, [resolve(root, "membership-in-loop.py")]);
  expect(result).toEqual({state: "unavailable", diagnostics: [], findings: []});
});

it("uses captured text and reports missing project context as partial", async () => {
  const root = resolve("fixtures/corpus/typescript");
  const result = await scanTypeScriptSnapshot(root, [
    {
      path: "captured.ts",
      text: "export function captured(values: string[]) { for (const value of values) values.includes(value); }",
    },
  ]);
  expect(result.state).toBe("partial");
  expect(result.index?.files).toEqual(["captured.ts"]);
  expect(result.index?.definitions.some((definition) => definition.name === "captured")).toBe(true);
  expect(result.findings).toContainEqual(
    expect.objectContaining({location: expect.objectContaining({path: "captured.ts"})}),
  );
  expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "typescript-project-context-partial"}));
});
