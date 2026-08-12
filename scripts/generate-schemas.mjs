import {mkdir, writeFile} from "node:fs/promises";
import {Protocol} from "../dist/protocol/index.js";
import {z} from "zod";

const schemas = {
  "location-v1": Protocol.location,
  "problem-v1": Protocol.problem,
  "action-required-v1": Protocol.actionRequired,
  "coverage-v1": Protocol.coverage,
  "finding-v2": Protocol.finding,
  "repository-inventory-v1": Protocol.inventory,
  "context-index-v1": Protocol.contextIndex,
  "scan-report-v2": Protocol.scanReport,
  "adapter-manifest-v1": Protocol.adapterManifest,
  "adapter-request-v1": Protocol.adapterRequest,
  "adapter-result-v2": Protocol.adapterResult,
  "evidence-v2": Protocol.evidence,
  "measurement-v1": Protocol.measurement,
  "benchmark-record-v2": Protocol.benchmarkRecord,
  "benchmark-import-v2": Protocol.benchmarkImport,
  "profile-summary-v1": Protocol.profileSummary,
  "trace-summary-v1": Protocol.traceSummary,
  "scaling-v2": Protocol.scaling,
  "scaling-v3": Protocol.multiScaling,
  "comparison-v2": Protocol.comparison,
  "investigation-bundle-v2": Protocol.investigation,
  "investigation-pointer-v1": Protocol.investigationPointer,
};

const semanticSchemas = new Set([
  "adapter-result-v2",
  "benchmark-import-v2",
  "benchmark-record-v2",
  "evidence-v2",
  "finding-v2",
  "investigation-bundle-v2",
  "scan-report-v2",
]);

await mkdir("schemas", {recursive: true});
for (const [name, schema] of Object.entries(schemas)) {
  const document = z.toJSONSchema(schema, {target: "draft-2020-12", io: "output"});
  if (semanticSchemas.has(name))
    document.$comment =
      "Structural JSON Schema only. Parse boundary input with SmokingGun's exported Protocol schema, which enforces semantic cross-field constraints.";
  await writeFile(`schemas/${name}.schema.json`, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
