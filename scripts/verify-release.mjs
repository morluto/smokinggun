import {createHash} from "node:crypto";
import {readdir, readFile, stat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const run = promisify(execFile);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const grammarLock = JSON.parse(await readFile("grammar.lock.json", "utf8"));
const failures = [];

if (packageJson.name !== "smokinggun") failures.push("package name is not smokinggun");
if (Object.keys(packageJson.bin ?? {}).join(",") !== "smokinggun")
  failures.push("package exposes more than the smokinggun executable");
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
  const binInfo = await stat("dist/bin/smokinggun.js").catch(() => undefined);
  if (binInfo === undefined || (binInfo.mode & 0o111) === 0) failures.push("dist/bin/smokinggun.js is not executable");
}

// Windows requires the shell to execute npm.cmd; Unix can invoke npm directly.
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npmOptions = process.platform === "win32" ? {encoding: "utf8", shell: true} : {encoding: "utf8"};
const {stdout} = await run(npmCmd, ["pack", "--dry-run", "--json", "--ignore-scripts"], npmOptions);
// npm pack may print lifecycle-script output (e.g. simple-git-hooks) ahead of the JSON document.
const jsonStart = stdout.match(/^\[(?=\s*\{)/m);
if (jsonStart === null) failures.push("npm pack --dry-run produced no parseable JSON");
const pack = jsonStart === null ? undefined : JSON.parse(stdout.slice(jsonStart.index))[0];
if (pack !== undefined) {
  const paths = pack.files.map((entry) => entry.path);
  for (const forbidden of ["scripts/", "node_modules/", ".test.", ".map"]) {
    if (paths.some((path) => path.includes(forbidden))) failures.push(`forbidden packed path contains ${forbidden}`);
  }
  const schemaFiles = (await readdir("schemas")).filter((file) => file.endsWith(".schema.json"));
  for (const required of [
    "dist/bin/smokinggun.js",
    "grammar.lock.json",
    "skills/smokinggun/SKILL.md",
    ...schemaFiles.map((file) => `schemas/${file}`),
  ]) {
    if (!paths.includes(required)) failures.push(`missing packed path ${required}`);
  }
  if (paths.some((path) => path.startsWith("skill/") || path.startsWith("skill\\")))
    failures.push("legacy skill directory is still packed");
  if (paths.some((path) => path.startsWith("skills/") && path.includes("/agents/")))
    failures.push("host-specific skill metadata is packed");
  if (pack.size > 12_000_000) failures.push(`compressed package exceeds 12 MB (${pack.size})`);
  if (pack.unpackedSize > 40_000_000) failures.push(`unpacked package exceeds 40 MB (${pack.unpackedSize})`);
  if (failures.length === 0) {
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
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `release verification: ${failure}`).join("\n"));
  process.exitCode = 1;
}
