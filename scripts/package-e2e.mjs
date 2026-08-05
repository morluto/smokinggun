import {execFile, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createServer} from "node:net";
import {promisify} from "node:util";

const run = promisify(execFile);
const root = process.cwd();
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const sandbox = await mkdtemp(join(tmpdir(), "footgun-package-e2e-"));
const registryPort = await freePort();
const registry = `http://127.0.0.1:${registryPort}`;
const registryConfig = join(sandbox, "config.yaml");
const storage = join(sandbox, "storage");
const packageTarball = join(root, `${packageJson.name}-${packageJson.version}.tgz`);
const password = "footgun-password";
const config = `storage: ${storage}\nweb:\n  enable: false\nauth:\n  htpasswd:\n    file: ${join(sandbox, "htpasswd")}\nuplinks:\n  npmjs:\n    url: https://registry.npmjs.org/\npackages:\n  '**':\n    access: $all\n    publish: $all\n    unpublish: $all\n    proxy: npmjs\nlog:\n  type: stdout\n  format: pretty\n  level: warn\n`;

await writeFile(registryConfig, config, "utf8");
await writeFile(join(sandbox, "htpasswd"), `footgun:{SHA}${createHash("sha1").update(password).digest("base64")}\n`, "utf8");
await writeFile(join(sandbox, ".npmrc"), `registry=${registry}\n//127.0.0.1:${registryPort}/:_auth=${Buffer.from(`footgun:${password}`).toString("base64")}\nalways-auth=true\n`, "utf8");
await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], {cwd: root, maxBuffer: 1_000_000});
let registryProcess;
try {
  registryProcess = await startRegistry();
  await run("npm", ["publish", packageTarball, "--registry", registry, "--access", "public", "--ignore-scripts"], {cwd: sandbox, maxBuffer: 1_000_000});
  const consumer = join(sandbox, "consumer");
  await run("npm", ["install", "--prefix", consumer, `${packageJson.name}@${packageJson.version}`, "--registry", registry, "--ignore-scripts"], {cwd: sandbox, maxBuffer: 1_000_000});
  await run("npm", ["install", "--prefix", consumer, `${packageJson.name}@${packageJson.version}`, "--registry", registry, "--ignore-scripts"], {cwd: sandbox, maxBuffer: 1_000_000});
  const executable = join(consumer, "node_modules", ".bin", "footgun");
  const doctor = await run(executable, ["doctor", "--format", "json", "--non-interactive"], {cwd: sandbox, maxBuffer: 1_000_000});
  const doctorValue = JSON.parse(doctor.stdout);
  if (doctorValue.schemaVersion !== "footgun.doctor.v1") throw new Error("packed consumer doctor returned an unexpected document");
  const codexHome = join(sandbox, "codex-home");
  const skill = await run(executable, ["skill", "install", "--format", "json"], {cwd: sandbox, env: {...process.env, CODEX_HOME: codexHome}, maxBuffer: 1_000_000});
  const skillValue = JSON.parse(skill.stdout);
  if (skillValue.schemaVersion !== "footgun.skill-install.v1") throw new Error("packed consumer skill install returned an unexpected document");
  const installedSkill = join(codexHome, "skills", "complexity-optimizer", "SKILL.md");
  const installedText = await readFile(installedSkill, "utf8");
  if (!installedText.includes("footgun scan")) throw new Error("packed consumer installed an incomplete skill");
  const conflict = await run("node", ["-e", `const {execFile}=require('node:child_process');execFile(${JSON.stringify(executable)}, ['skill','install','--format','json'], {env: process.env}, (error, stdout, stderr) => { process.stdout.write(JSON.stringify({code: error?.code ?? 0, stdout, stderr})); });`], {cwd: sandbox, env: {...process.env, CODEX_HOME: codexHome}, maxBuffer: 1_000_000});
  const conflictValue = JSON.parse(conflict.stdout);
  if (conflictValue.code !== 2 || JSON.parse(conflictValue.stdout).code !== "skill-destination-exists") throw new Error("packed consumer skill conflict protection failed");
  const forced = await run(executable, ["skill", "install", "--force", "--format", "json"], {cwd: sandbox, env: {...process.env, CODEX_HOME: codexHome}, maxBuffer: 1_000_000});
  const forcedValue = JSON.parse(forced.stdout);
  if (forcedValue.schemaVersion !== "footgun.skill-install.v1" || typeof forcedValue.backup !== "string") throw new Error("packed consumer skill backup flow failed");
  if (!(await readFile(join(forcedValue.backup, "SKILL.md"), "utf8")).includes("footgun scan")) throw new Error("packed consumer skill backup was not preserved");
  const npxDoctor = await run("npm", ["exec", "--yes", `--package=${packageJson.name}@${packageJson.version}`, "--", "footgun", "scanners", "list", "--format", "json"], {cwd: sandbox, env: {...process.env, npm_config_registry: registry}, maxBuffer: 1_000_000});
  const scanners = JSON.parse(npxDoctor.stdout);
  if (scanners.schemaVersion !== "footgun.scanners.v1") throw new Error("npm exec did not invoke the packed registry artifact");
  const offline = await run("npm", ["exec", "--offline", "--yes", `--package=${packageJson.name}@${packageJson.version}`, "--", "footgun", "scanners", "list", "--format", "json"], {cwd: sandbox, env: {...process.env, npm_config_registry: registry}, maxBuffer: 1_000_000});
  if (JSON.parse(offline.stdout).schemaVersion !== "footgun.scanners.v1") throw new Error("offline npm exec did not reuse the cached package");
  const globalPrefix = join(sandbox, "global");
  await run("npm", ["install", "--global", "--prefix", globalPrefix, `${packageJson.name}@${packageJson.version}`, "--registry", registry, "--ignore-scripts"], {cwd: sandbox, maxBuffer: 1_000_000});
  const globalDoctor = await run(join(globalPrefix, "bin", "footgun"), ["scanners", "list", "--format", "json"], {cwd: sandbox, maxBuffer: 1_000_000});
  if (JSON.parse(globalDoctor.stdout).schemaVersion !== "footgun.scanners.v1") throw new Error("global install did not invoke the packed registry artifact");
  console.log(JSON.stringify({registry, package: `${packageJson.name}@${packageJson.version}`, scannerCount: scanners.scanners.length, skill: installedSkill, offline: true, global: true}));
} finally {
  if (registryProcess !== undefined) {
    registryProcess.kill("SIGTERM");
    await registryProcess.exit;
  }
  await rm(packageTarball, {force: true});
  await rm(sandbox, {recursive: true, force: true});
}

async function startRegistry() {
  const executable = resolve(root, "node_modules/.bin/verdaccio");
  const child = spawn(executable, ["--config", registryConfig, "--listen", registry], {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  const exit = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({code, signal})));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Verdaccio exited before becoming ready (code ${child.exitCode}).`);
    try {
      const response = await fetch(`${registry}/-/ping`);
      if (response.ok) return {kill: (signal) => child.kill(signal), exit};
    } catch {
      // The registry may still be binding its listener.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  child.kill("SIGTERM");
  throw new Error("Verdaccio did not become ready");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  await new Promise((resolveClosed, reject) => server.close((error) => error === undefined ? resolveClosed() : reject(error)));
  if (address === null || typeof address === "string") throw new Error("Could not determine an ephemeral registry port.");
  return address.port;
}
