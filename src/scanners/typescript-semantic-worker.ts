import {parentPort, workerData} from "node:worker_threads";
import {z} from "zod";
import {scanTypeScriptSynchronously} from "./typescript-semantic.js";

const workerInput = z.strictObject({root: z.string(), files: z.array(z.string())});
const input = workerInput.parse(workerData);

try {
  const result = scanTypeScriptSynchronously(input.root, input.files);
  parentPort?.postMessage({result});
} finally {
  parentPort?.close();
}
