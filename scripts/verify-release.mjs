import {createHash} from "node:crypto";
import {readdir, readFile, stat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const run = promisify(execFile);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const grammarLock = JSON.parse(await readFile("grammar.lock.json", "utf8"));
const failures = [];

if (packageJson.name !== "footgun") failures.push("package name is not footgun");
if (Object.keys(packageJson.bin ?? {}).join(",") !== "footgun")
  failures.push("package exposes more than the footgun executable");
for (const grammar of grammarLock.grammars ?? []) {
  const bytes = await readFile(grammar.file).catch(() => undefined);
  if (bytes === undefined) {
    failures.push(`missing grammar ${grammar.file}`);
  } else if (createHash("sha256").update(bytes).digest("hex") !== grammar.sha256) {
    failures.push(`grammar digest mismatch ${grammar.file}`);
  }
}
// Windows does not model executable bits; the shebang and node invocation cover entry-point execution there.
if (process.platform !== "win32") {
  const binInfo = await stat("dist/bin/footgun.js").catch(() => undefined);
  if (binInfo === undefined || (binInfo.mode & 0o111) === 0) failures.push("dist/bin/footgun.js is not executable");
}

const {stdout} = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {encoding: "utf8"});
const pack = JSON.parse(stdout)[0];
const paths = pack.files.map((entry) => entry.path);
for (const forbidden of ["scripts/", "node_modules/", ".test.", ".map"]) {
  if (paths.some((path) => path.includes(forbidden))) failures.push(`forbidden packed path contains ${forbidden}`);
}
const schemaFiles = (await readdir("schemas")).filter((file) => file.endsWith(".schema.json"));
for (const required of [
  "dist/bin/footgun.js",
  "grammar.lock.json",
  "skill/SKILL.md",
  ...schemaFiles.map((file) => `schemas/${file}`),
]) {
  if (!paths.includes(required)) failures.push(`missing packed path ${required}`);
}
if (pack.size > 12_000_000) failures.push(`compressed package exceeds 12 MB (${pack.size})`);
if (pack.unpackedSize > 40_000_000) failures.push(`unpacked package exceeds 40 MB (${pack.unpackedSize})`);

if (failures.length > 0) {
  console.error(failures.map((failure) => `release verification: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        files: paths.length,
        compressedBytes: pack.size,
        unpackedBytes: pack.unpackedSize,
      },
      null,
      2,
    ),
  );
}
