import {mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {create, toBinary} from "@bufbuild/protobuf";
import {IndexSchema, ProtocolVersion, SymbolInformation_Kind, SymbolRole, TextEncoding} from "@scip-code/scip";
import {expect, it} from "vitest";
import {Protocol} from "../protocol/index.js";
import {importScip} from "./scip.js";

it("imports SCIP definitions and references with repository-relative coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smokinggun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    const index = create(IndexSchema, {
      metadata: {
        version: ProtocolVersion.UnspecifiedProtocolVersion,
        toolInfo: {name: "fixture-indexer", version: "1.0.0"},
        projectRoot: directory,
        textDocumentEncoding: TextEncoding.UTF8,
      },
      documents: [
        {
          language: "TypeScript",
          relativePath: "src/main.ts",
          symbols: [{symbol: "local 0", displayName: "main", kind: SymbolInformation_Kind.Function}],
          occurrences: [
            {range: [0, 0, 4], symbol: "local 0", symbolRoles: SymbolRole.Definition},
            {range: [1, 0, 4], symbol: "local 0", symbolRoles: SymbolRole.ReadAccess},
          ],
        },
      ],
    });
    await writeFile(artifact, toBinary(IndexSchema, index));
    const result = await importScip(artifact, directory);
    expect(result.state).toBe("complete");
    expect(result.index?.files).toEqual(["src/main.ts"]);
    expect(result.index?.definitions[0]?.name).toBe("main");
    expect(result.index?.references[0]?.resolved).toBe(true);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it("rejects symlinked SCIP artifacts at the import boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smokinggun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    const link = join(directory, "index-link.scip");
    await writeFile(artifact, toBinary(IndexSchema, create(IndexSchema)));
    await symlink(artifact, link);
    const result = await importScip(link, directory);
    expect(result.state).toBe("unavailable");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "scip-import-failed"}));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it("does not expose invalid SCIP document paths in context coverage or diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smokinggun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    await writeFile(
      artifact,
      toBinary(
        IndexSchema,
        create(IndexSchema, {documents: [{language: "TypeScript", relativePath: "/host/private.ts"}]}),
      ),
    );
    const result = await importScip(artifact, directory);
    expect(result.state).toBe("partial");
    expect(result.index?.coverage.skippedFiles).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("/host/private.ts");
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it("rejects non-canonical SCIP document paths instead of silently normalizing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smokinggun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    await writeFile(
      artifact,
      toBinary(
        IndexSchema,
        create(IndexSchema, {documents: [{language: "TypeScript", relativePath: "src/../private.ts"}]}),
      ),
    );
    const result = await importScip(artifact, directory);
    expect(result.state).toBe("partial");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "scip-path-invalid"}));
    expect(result.index?.files).toEqual([]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it("rejects SCIP document paths with trailing separators", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smokinggun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    await writeFile(
      artifact,
      toBinary(IndexSchema, create(IndexSchema, {documents: [{language: "TypeScript", relativePath: "src/"}]})),
    );
    const result = await importScip(artifact, directory);
    expect(result.state).toBe("partial");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "scip-path-invalid"}));
    expect(result.index?.files).toEqual([]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

it("marks duplicate SCIP document paths as partial before constructing the context index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smokinggun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    await writeFile(
      artifact,
      toBinary(
        IndexSchema,
        create(IndexSchema, {
          documents: [
            {language: "TypeScript", relativePath: "src/main.ts"},
            {language: "TypeScript", relativePath: "src/main.ts"},
          ],
        }),
      ),
    );
    const result = await importScip(artifact, directory);
    expect(result.state).toBe("partial");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({code: "scip-document-duplicate"}));
    expect(result.index?.coverage).toMatchObject({filesDiscovered: 2, filesIndexed: 1, parseStatus: "partial"});
    expect(result.index === undefined ? false : Protocol.contextIndex.safeParse(result.index).success).toBe(true);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
