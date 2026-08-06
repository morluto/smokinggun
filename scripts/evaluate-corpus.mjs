import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve} from "node:path";
import {scanTypeScript} from "../dist/scanners/typescript-semantic.js";
import {scanSource} from "../dist/scanners/structural.js";
import {parseWithTreeSitter} from "../dist/parsers/tree-sitter-runtime.js";
import {scanWithTreeSitter} from "../dist/scanners/tree-sitter-structural.js";
import {scanPythonSemantic} from "../dist/scanners/python-semantic.js";

const root = resolve("fixtures/corpus");
const cases = JSON.parse(await readFile(resolve(root, "labels.json"), "utf8"));
const perLanguage = {};
const perRule = {};
let truePositives = 0;
let falsePositives = 0;
let expectedPositives = 0;
for (const testCase of cases) {
  const source = await readFile(resolve(root, testCase.path), "utf8");
  const treeStructural = await scanWithTreeSitter(testCase.path, source);
  const structural = new Set(
    (treeStructural.coverage.status === "complete"
      ? treeStructural.findings
      : scanSource(testCase.path, source).findings
    ).map((finding) => finding.ruleId),
  );
  const semantic = new Set(
    scanTypeScript(root, [resolve(root, testCase.path)]).findings.map((finding) => finding.ruleId),
  );
  if (testCase.language === "python")
    for (const finding of (await scanPythonSemantic(testCase.path, source)).findings) semantic.add(finding.ruleId);
  const expected = new Set([...testCase.expectedStructural, ...testCase.expectedSemantic]);
  const actual = new Set([...structural, ...semantic]);
  const language = (perLanguage[testCase.language] ??= {truePositives: 0, falsePositives: 0, expectedPositives: 0});
  language.expectedPositives += expected.size;
  expectedPositives += expected.size;
  for (const rule of expected) {
    const hit = actual.has(rule);
    if (hit) truePositives += 1;
    else falsePositives += 1;
    const metric = (perRule[rule] ??= {truePositives: 0, falsePositives: 0, expectedPositives: 0});
    metric.expectedPositives += 1;
    if (hit) metric.truePositives += 1;
    else metric.falsePositives += 1;
  }
  for (const rule of actual) {
    if (expected.has(rule)) continue;
    falsePositives += 1;
    const metric = (perRule[rule] ??= {truePositives: 0, falsePositives: 0, expectedPositives: 0});
    metric.falsePositives += 1;
  }
  for (const rule of actual) if (!expected.has(rule)) language.falsePositives += 1;
  language.truePositives += [...expected].filter((rule) => actual.has(rule)).length;
}
const fixtures = [...new Set(cases.map((testCase) => testCase.path))];
const corpusDigest = createHash("sha256");
for (const path of [...fixtures, "labels.json"].sort())
  corpusDigest
    .update(path)
    .update("\0")
    .update(await readFile(resolve(root, path)))
    .update("\0");
const parseResults = await Promise.all(
  fixtures.map(async (path) => parseWithTreeSitter(path, await readFile(resolve(root, path), "utf8"))),
);
const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
const recall = expectedPositives === 0 ? 1 : truePositives / expectedPositives;
const rates = (metric) => ({
  ...metric,
  precision:
    metric.truePositives + metric.falsePositives === 0
      ? 1
      : metric.truePositives / (metric.truePositives + metric.falsePositives),
  recall: metric.expectedPositives === 0 ? 1 : metric.truePositives / metric.expectedPositives,
});
const summary = {
  corpusRevision: corpusDigest.digest("hex"),
  overall: {precision, recall, truePositives, falsePositives, expectedPositives},
  perLanguage: Object.fromEntries(Object.entries(perLanguage).map(([key, value]) => [key, rates(value)])),
  perRule: Object.fromEntries(Object.entries(perRule).map(([key, value]) => [key, rates(value)])),
  parseCoverage: {
    complete: parseResults.filter((result) => result.status === "complete").length,
    total: parseResults.length,
  },
};
console.log(JSON.stringify(summary, null, 2));
const metricFailures = [...Object.entries(summary.perLanguage), ...Object.entries(summary.perRule)].flatMap(
  ([name, metric]) => [
    ...(metric.precision < 0.9 ? [`${name} precision ${metric.precision.toFixed(3)} < 0.900`] : []),
    ...(metric.recall < 0.8 ? [`${name} recall ${metric.recall.toFixed(3)} < 0.800`] : []),
  ],
);
const parseRate = summary.parseCoverage.total === 0 ? 1 : summary.parseCoverage.complete / summary.parseCoverage.total;
if (precision < 0.9 || recall < 0.8 || parseRate < 0.99 || metricFailures.length > 0) {
  console.error(
    JSON.stringify({
      code: "corpus-threshold-failed",
      failures: [
        ...metricFailures,
        ...(precision < 0.9 ? [`overall precision ${precision.toFixed(3)} < 0.900`] : []),
        ...(recall < 0.8 ? [`overall recall ${recall.toFixed(3)} < 0.800`] : []),
        ...(parseRate < 0.99 ? [`parse coverage ${parseRate.toFixed(3)} < 0.990`] : []),
      ],
    }),
  );
  process.exitCode = 1;
}
