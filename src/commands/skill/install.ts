import {createHash, randomUUID} from "node:crypto";
import {copyFile, lstat, mkdir, readdir, readFile, rename, rm} from "node:fs/promises";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Flags} from "@oclif/core";
import {BaseCommand, globalFlags, type ParsedGlobalFlags} from "../../cli/base-command.js";
import type {RuntimeContext} from "../../cli/context.js";
import {comparePortable} from "../../paths.js";
import {writeResult} from "../../cli/output.js";
import {renderCommandResult} from "../../cli/command-output.js";

type FileDigest = {readonly relativePath: string; readonly digest: string};

export default class SkillInstall extends BaseCommand {
  static override description = "Install the bundled Codex complexity-optimizer skill.";
  static override flags = {
    ...globalFlags,
    force: Flags.boolean({description: "Back up and replace an existing skill.", default: false}),
    "dry-run": Flags.boolean({description: "Show the destination and digest without writing.", default: false}),
  };
  static override args = {};

  public async run(): Promise<void> {
    const parsed = await this.parse(SkillInstall);
    const context = await this.context(parsed.flags as ParsedGlobalFlags);
    const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
    const destination = join(codexHome, "skills", "complexity-optimizer");
    const source = fileURLToPath(new URL("../../../skill", import.meta.url));
    await validateBundledSkill(source);
    const digest = await directoryDigest(source);
    const exists = await pathExists(destination);
    if (parsed.flags["dry-run"]) {
      await this.emitStatus(
        {schemaVersion: "footgun.skill-install.v1", destination, digest, dryRun: true, exists},
        `Skill destination: ${destination}\nDigest: ${digest}\n${exists ? "Existing skill would require --force." : "Ready to install."}`,
        context,
      );
      return;
    }
    if (exists && !parsed.flags.force)
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "skill-destination-exists",
          message: `Skill destination already exists: ${destination}`,
          recovery: `Run 'footgun skill install --force' to back it up before replacement.`,
        },
        2,
        context,
      );
    await mkdir(dirname(destination), {recursive: true});
    const temporary = join(dirname(destination), `.complexity-optimizer.${randomUUID()}.tmp`);
    let backup: string | undefined;
    let installed = false;
    try {
      await copyDirectory(source, temporary);
      const copiedDigest = await directoryDigest(temporary);
      if (copiedDigest !== digest) throw new Error("Bundled skill digest changed while copying.");
      if (exists) {
        backup = `${destination}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
        await rename(destination, backup);
      }
      await rename(temporary, destination);
      const installedDigest = await directoryDigest(destination);
      if (installedDigest !== digest) throw new Error("Installed skill digest verification failed.");
      installed = true;
      await this.emitStatus(
        {schemaVersion: "footgun.skill-install.v1", destination, digest, dryRun: false, exists, backup},
        `Installed $complexity-optimizer at ${destination}\nDigest: ${digest}${backup === undefined ? "" : `\nBackup: ${backup}`}`,
        context,
      );
    } catch (cause: unknown) {
      await rm(temporary, {recursive: true, force: true}).catch(() => undefined);
      let restoreFailure: string | undefined;
      if (!installed && backup !== undefined) {
        await rm(destination, {recursive: true, force: true}).catch(() => undefined);
        try {
          await rename(backup, destination);
        } catch (restoreCause: unknown) {
          restoreFailure = restoreCause instanceof Error ? restoreCause.message : "unknown restore failure";
        }
      } else if (!installed && !exists) {
        await rm(destination, {recursive: true, force: true}).catch(() => undefined);
      }
      const message = `${cause instanceof Error ? cause.message : "Skill installation failed."}${restoreFailure === undefined ? "" : ` Backup restoration also failed: ${restoreFailure}`}`;
      this.emitProblem(
        {
          schemaVersion: "footgun.problem.v1",
          code: "skill-install-failed",
          message,
          recovery: "Check CODEX_HOME permissions and rerun the install.",
        },
        1,
        context,
      );
    }
  }

  private async emitStatus(value: unknown, human: string, context: RuntimeContext): Promise<void> {
    const text = renderCommandResult(value, human, context.config.format);
    await writeResult(text, context);
    if (!context.config.quiet || context.config.format !== "human") context.stdout.write(text);
  }
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, {recursive: true});
  const entries = await readdir(source, {withFileTypes: true});
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Bundled skill contains an unsupported symlink: ${entry.name}`);
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Bundled skill contains unsupported entry: ${entry.name}`);
  }
}

async function validateBundledSkill(source: string): Promise<void> {
  const files = [...(await filesIn(source))].sort(comparePortable);
  const expected = ["SKILL.md", "agents/openai.yaml"];
  if (files.length !== expected.length || files.some((file, index) => file !== expected[index]))
    throw new Error("Bundled skill contents do not match the Footgun skill contract.");
}

async function directoryDigest(directory: string): Promise<string> {
  const files = await filesIn(directory);
  const entries: FileDigest[] = [];
  for (const relativePath of files) {
    const path = join(directory, relativePath);
    const content = await readFile(path);
    entries.push({relativePath, digest: createHash("sha256").update(content).digest("hex")});
  }
  const encoded = entries
    .sort((left, right) => comparePortable(left.relativePath, right.relativePath))
    .map((entry) => `${entry.relativePath}\0${entry.digest}`)
    .join("\n");
  return createHash("sha256").update(encoded).digest("hex");
}

async function filesIn(directory: string, prefix = ""): Promise<ReadonlyArray<string>> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Skill contains an unsupported symlink: ${relativePath}`);
    if (entry.isDirectory()) files.push(...(await filesIn(join(directory, entry.name), relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
