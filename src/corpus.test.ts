import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {expect, it} from "vitest";
import {scanSource} from "./scanners/structural.js";
import {scanTypeScript} from "./scanners/typescript-semantic.js";
import {parseWithTreeSitter} from "./parsers/tree-sitter-runtime.js";
import {scanWithTreeSitter} from "./scanners/tree-sitter-structural.js";
import {scanPythonSemantic} from "./scanners/python-semantic.js";
import {z} from "zod";

const corpus = resolve("fixtures/corpus");

it("meets the labeled corpus precision and recall gate for the shipped rules", async () => {
  const cases = z
    .array(
      z.strictObject({
        language: z.string().min(1),
        path: z.string().min(1),
        expectedStructural: z.array(z.string()),
        expectedSemantic: z.array(z.string()),
      }),
    )
    .parse(JSON.parse(await readFile(resolve(corpus, "labels.json"), "utf8")));
  const metrics = new Map<string, {truePositives: number; falsePositives: number; expectedPositives: number}>();
  for (const testCase of cases) {
    const file = resolve(corpus, testCase.path);
    const source = await readFile(file, "utf8");
    const treeStructural = await scanWithTreeSitter(testCase.path, source);
    const structural = (
      treeStructural.coverage.status === "complete"
        ? treeStructural.findings
        : scanSource(testCase.path, source).findings
    ).map((finding) => finding.ruleId);
    const semantic = scanTypeScript(corpus, [file]).findings.map((finding) => finding.ruleId);
    if (testCase.language === "python")
      semantic.push(...(await scanPythonSemantic(testCase.path, source)).findings.map((finding) => finding.ruleId));
    const expected = new Set([...(testCase.expectedStructural ?? []), ...(testCase.expectedSemantic ?? [])]);
    const actual = new Set([...structural, ...semantic]);
    const current = metrics.get(testCase.language) ?? {truePositives: 0, falsePositives: 0, expectedPositives: 0};
    current.expectedPositives += expected.size;
    for (const rule of expected) {
      if (actual.has(rule)) current.truePositives += 1;
      else current.falsePositives += 1;
    }
    for (const rule of actual) if (!expected.has(rule)) current.falsePositives += 1;
    metrics.set(testCase.language, current);
  }
  for (const [language, current] of metrics) {
    const precision =
      current.truePositives + current.falsePositives === 0
        ? 1
        : current.truePositives / (current.truePositives + current.falsePositives);
    const recall = current.expectedPositives === 0 ? 1 : current.truePositives / current.expectedPositives;
    expect(precision, `${language} precision`).toBeGreaterThanOrEqual(0.9);
    expect(recall, `${language} recall`).toBeGreaterThanOrEqual(0.8);
  }
}, 60_000);

it("records complete parse coverage for every shipped grammar fixture", async () => {
  const fixtures = [
    "c/canonical.c",
    "c/positive.c",
    "cpp/canonical.cpp",
    "cpp/positive.cpp",
    "csharp/Canonical.cs",
    "csharp/Positive.cs",
    "go/canonical.go",
    "go/positive.go",
    "java/Canonical.java",
    "java/Positive.java",
    "javascript/comments-and-strings.js",
    "javascript/positive.js",
    "kotlin/Canonical.kt",
    "kotlin/Positive.kt",
    "php/canonical.php",
    "php/positive.php",
    "python/membership-in-loop.py",
    "ruby/canonical.rb",
    "ruby/positive.rb",
    "rust/canonical.rs",
    "rust/positive.rs",
    "swift/canonical.swift",
    "swift/Positive.swift",
    "typescript/negative.ts",
    "typescript/nested-scan.ts",
    "typescript/positive.ts",
  ];
  const results = await Promise.all(
    fixtures.map(async (path) => parseWithTreeSitter(path, await readFile(resolve(corpus, path), "utf8"))),
  );
  const complete = results.filter((result) => result.status === "complete").length;
  expect(complete / results.length).toBeGreaterThanOrEqual(0.99);
  expect(results.every((result) => result.status === "complete")).toBe(true);
});
