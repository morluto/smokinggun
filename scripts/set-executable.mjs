import {chmod} from "node:fs/promises";

await chmod("dist/bin/footgun.js", 0o755);
