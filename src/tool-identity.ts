import {readFileSync} from "node:fs";
import {z} from "zod";

const packageMetadataSchema = z.object({version: z.string().min(1)});
const packageMetadata = packageMetadataSchema.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
);

export const toolIdentity = {name: "smokinggun", version: packageMetadata.version} as const;

export function parsePackageMetadata(input: unknown): {readonly version: string} {
  return packageMetadataSchema.parse(input);
}
