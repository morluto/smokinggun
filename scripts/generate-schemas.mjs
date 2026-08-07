import {mkdir, writeFile} from "node:fs/promises";
import {Protocol} from "../dist/protocol/index.js";
import {z} from "zod";

const schemas = {
  "location-v1": Protocol.location,
  "problem-v1": Protocol.problem,
  "action-required-v1": Protocol.actionRequired,
  "coverage-v1": Protocol.coverage,
  "finding-v1": Protocol.finding,
  "repository-inventory-v1": Protocol.inventory,
  "context-index-v1": Protocol.contextIndex,
  "scan-report-v1": Protocol.scanReport,
  "adapter-manifest-v1": Protocol.adapterManifest,
  "adapter-request-v1": Protocol.adapterRequest,
  "adapter-result-v1": Protocol.adapterResult,
  "workload-v1": Protocol.workload,
  "evidence-v1": Protocol.evidence,
  "measurement-v1": Protocol.measurement,
  "benchmark-record-v1": Protocol.benchmarkRecord,
  "benchmark-import-v1": Protocol.benchmarkImport,
  "profile-summary-v1": Protocol.profileSummary,
  "trace-summary-v1": Protocol.traceSummary,
  "scaling-v1": Protocol.scaling,
  "scaling-v2": Protocol.multiScaling,
  "comparison-v1": Protocol.comparison,
  "investigation-bundle-v1": Protocol.investigation,
  "investigation-pointer-v1": Protocol.investigationPointer,
};

await mkdir("schemas", {recursive: true});
for (const [name, schema] of Object.entries(schemas)) {
  const document = z.toJSONSchema(schema, {target: "draft-2020-12", io: "output"});
  await writeFile(`schemas/${name}.schema.json`, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
