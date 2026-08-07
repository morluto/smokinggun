import {readFileSync} from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const toolIdentity = {name: "smokinggun", version: packageMetadata.version} as const;
