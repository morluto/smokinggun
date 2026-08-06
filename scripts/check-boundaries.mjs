#!/usr/bin/env node
// Enforce the module boundaries documented in AGENTS.md:
// - src/protocol owns contracts: it must not import any other src/ module.
// - src/commands only wires the CLI: nothing outside src/commands, src/bin, or src/cli may import it.
import {readdirSync, readFileSync, statSync} from "node:fs";
import {dirname, join, relative, resolve, sep} from "node:path";

const root = resolve(import.meta.dirname, "..");
const srcRoot = join(root, "src");
const specifierPattern = /(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g;
const violations = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walk(path));
    else if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

const inProtocol = (path) => path.startsWith("src/protocol/");
const inCommands = (path) => path.startsWith("src/commands/");
const inWiring = (path) =>
  path.startsWith("src/commands/") || path.startsWith("src/bin/") || path.startsWith("src/cli/");

for (const file of walk(srcRoot)) {
  const source = readFileSync(file, "utf8");
  const importer = relative(root, file).split(sep).join("/");
  specifierPattern.lastIndex = 0;
  let match;
  while ((match = specifierPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const target = relative(root, resolve(dirname(file), specifier))
      .split(sep)
      .join("/");
    if (!target.startsWith("src/")) continue;
    if (inProtocol(importer) && !inProtocol(target)) {
      violations.push(
        `${importer} must not import ${target}: src/protocol owns contracts and depends on no internal module.`,
      );
    }
    if (inCommands(target) && !inWiring(importer)) {
      violations.push(`${importer} must not import ${target}: src/commands only wires the CLI.`);
    }
  }
}

if (violations.length > 0) {
  console.error(`module boundary violations (${violations.length}):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("module boundaries: ok");
}
