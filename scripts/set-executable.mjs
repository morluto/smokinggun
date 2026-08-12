import {chmod} from "node:fs/promises";

await chmod("dist/bin/smokinggun.js", 0o755);
