#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL_NAME = "complexity-optimizer";
const args = new Set(process.argv.slice(2));
const silent = args.has("--silent");

function log(message) {
  if (!silent) {
    console.log(message);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.DS_Store`),
  });
}

function main() {
  const packageRoot = path.resolve(__dirname, "..");
  const source = path.join(packageRoot, SKILL_NAME);
  const codexHome = defaultCodexHome();
  const destination = path.join(codexHome, "skills", SKILL_NAME);

  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    fail(`Cannot find bundled skill at ${source}`);
  }

  copyDir(source, destination);

  log(`Installed $${SKILL_NAME} to ${destination}`);
  log("");
  log("Use it in Codex with:");
  log(`  Use $${SKILL_NAME} to analyze this codebase and give me a report.`);
}

main();
