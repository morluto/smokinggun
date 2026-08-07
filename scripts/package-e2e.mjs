import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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
await writeFile(
  join(sandbox, "htpasswd"),
  `footgun:{SHA}${createHash("sha1").update(password).digest("base64")}\n`,
  "utf8",
);
await writeFile(
  join(sandbox, ".npmrc"),
  `registry=${registry}\n//127.0.0.1:${registryPort}/:_auth=${Buffer.from(`footgun:${password}`).toString("base64")}\nalways-auth=true\n`,
  "utf8",
);
await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], {
  cwd: root,
  maxBuffer: 1_000_000,
});

let registryProcess;
try {
  registryProcess = await startRegistry();
  await run("npm", ["publish", packageTarball, "--registry", registry, "--access", "public", "--ignore-scripts"], {
    cwd: sandbox,
    maxBuffer: 1_000_000,
  });

  const target = join(sandbox, "target");
  await mkdir(target, {recursive: true});
  await writeFile(
    join(target, "example.js"),
    "const values = [1, 2, 3];\nfor (const value of values) console.log(value);\n",
    "utf8",
  );

  const consumer = join(sandbox, "consumer");
  const home = join(sandbox, "home");
  const npmCache = join(sandbox, "npm-cache");
  const consumerEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    npm_config_cache: npmCache,
  };
  await run(
    "npm",
    ["install", "--prefix", consumer, `${packageJson.name}@${packageJson.version}`, "--registry", registry],
    {cwd: sandbox, env: consumerEnv, maxBuffer: 1_000_000},
  );

  const installedManifest = JSON.parse(
    await readFile(join(consumer, "node_modules", packageJson.name, "package.json"), "utf8"),
  );
  if (installedManifest.scripts?.postinstall !== undefined)
    throw new Error("packed package defines a postinstall script");
  for (const agentDirectory of [".claude", ".cursor", ".agents", "skills"]) {
    if (await pathExists(join(home, agentDirectory)))
      throw new Error(`package install wrote agent directory ${agentDirectory}`);
  }

  const executable = join(consumer, "node_modules", ".bin", "smokinggun");
  const doctor = await run(executable, ["doctor", "--format", "json", "--non-interactive"], {
    cwd: sandbox,
    env: consumerEnv,
    maxBuffer: 1_000_000,
  });
  const doctorValue = JSON.parse(doctor.stdout);
  if (doctorValue.schemaVersion !== "footgun.doctor.v1")
    throw new Error("packed consumer doctor returned an unexpected document");

  const skillText = await readFile(
    join(consumer, "node_modules", packageJson.name, "skills", "smokinggun", "SKILL.md"),
    "utf8",
  );
  if (!skillText.includes("smokinggun scan ."))
    throw new Error("packed consumer contains an incomplete or host-specific skill");

  const npxScan = await run(
    "npx",
    [
      "--yes",
      `--package=${packageJson.name}@${packageJson.version}`,
      "--",
      "smokinggun",
      "scan",
      ".",
      "--format",
      "json",
    ],
    {cwd: target, env: {...consumerEnv, npm_config_registry: registry}, maxBuffer: 1_000_000},
  );
  const scan = JSON.parse(npxScan.stdout);
  if (scan.schemaVersion !== "footgun.scan-report.v1" || npxScan.stderr.length !== 0)
    throw new Error("npx did not run the packed CLI against a project outside the checkout");

  const scanners = await run(
    "npx",
    [
      "--yes",
      `--package=${packageJson.name}@${packageJson.version}`,
      "--",
      "smokinggun",
      "scanners",
      "list",
      "--format",
      "json",
    ],
    {cwd: sandbox, env: {...consumerEnv, npm_config_registry: registry}, maxBuffer: 1_000_000},
  );
  const scannerValue = JSON.parse(scanners.stdout);
  if (scannerValue.schemaVersion !== "footgun.scanners.v1") throw new Error("npx did not invoke the packed artifact");

  const globalPrefix = join(sandbox, "global");
  await run(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      globalPrefix,
      `${packageJson.name}@${packageJson.version}`,
      "--registry",
      registry,
    ],
    {cwd: sandbox, env: consumerEnv, maxBuffer: 1_000_000},
  );
  const globalScanners = await run(join(globalPrefix, "bin", "smokinggun"), ["scanners", "list", "--format", "json"], {
    cwd: sandbox,
    env: consumerEnv,
    maxBuffer: 1_000_000,
  });
  if (JSON.parse(globalScanners.stdout).schemaVersion !== "footgun.scanners.v1")
    throw new Error("global install did not invoke the packed registry artifact");

  console.log(
    JSON.stringify({
      registry,
      package: `${packageJson.name}@${packageJson.version}`,
      scannerCount: scannerValue.scanners.length,
      npxScan: true,
      global: true,
      skill: "skills/smokinggun/SKILL.md",
      agentDirectoriesCreated: false,
    }),
  );
} finally {
  if (registryProcess !== undefined) {
    registryProcess.kill("SIGTERM");
    await registryProcess.exit;
  }
  await rm(packageTarball, {force: true});
  await rm(sandbox, {recursive: true, force: true});
}

async function startRegistry() {
  const executable = join(root, "node_modules", ".bin", "verdaccio");
  const child = spawn(executable, ["--config", registryConfig, "--listen", registry], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  await new Promise((resolveClosed, reject) =>
    server.close((error) => (error === undefined ? resolveClosed() : reject(error))),
  );
  if (address === null || typeof address === "string")
    throw new Error("Could not determine an ephemeral registry port.");
  return address.port;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
