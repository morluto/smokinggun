import {parentPort, workerData} from "node:worker_threads";
import {z} from "zod";
import {scanTypeScriptSnapshotSynchronously, scanTypeScriptSynchronously} from "./typescript-semantic.js";

const workerInput = z.strictObject({
  root: z.string(),
  files: z.array(z.string()),
  sources: z.array(z.strictObject({path: z.string(), text: z.string()})).optional(),
});
const input = workerInput.parse(workerData);

try {
  const result =
    input.sources === undefined
      ? scanTypeScriptSynchronously(input.root, input.files)
      : scanTypeScriptSnapshotSynchronously(input.root, input.sources);
  parentPort?.postMessage({result});
} finally {
  parentPort?.close();
}
