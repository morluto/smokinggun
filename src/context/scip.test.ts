import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {create, toBinary} from "@bufbuild/protobuf";
import {IndexSchema, ProtocolVersion, SymbolInformation_Kind, SymbolRole, TextEncoding} from "@scip-code/scip";
import {expect, it} from "vitest";
import {importScip} from "./scip.js";

it("imports SCIP definitions and references with repository-relative coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "footgun-scip-"));
  try {
    const artifact = join(directory, "index.scip");
    const index = create(IndexSchema, {
      metadata: {version: ProtocolVersion.UnspecifiedProtocolVersion, toolInfo: {name: "fixture-indexer", version: "1.0.0"}, projectRoot: directory, textDocumentEncoding: TextEncoding.UTF8},
      documents: [{
        language: "TypeScript",
        relativePath: "src/main.ts",
        symbols: [{symbol: "local 0", displayName: "main", kind: SymbolInformation_Kind.Function}],
        occurrences: [
          {range: [0, 0, 4], symbol: "local 0", symbolRoles: SymbolRole.Definition},
          {range: [1, 0, 4], symbol: "local 0", symbolRoles: SymbolRole.ReadAccess},
        ],
      }],
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
