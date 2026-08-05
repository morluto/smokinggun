import {createHash} from "node:crypto";
import {execa} from "execa";
import {gunzipSync} from "node:zlib";
import {parse as parseCsv} from "csv-parse/sync";
import {Profile} from "pprof-format";
import {z} from "zod";
import {Protocol, type ProblemV1, type ProfileSummaryV1, type TraceSummaryV1} from "../protocol/index.js";
import {comparePortable} from "../paths.js";
import {stableJson} from "../serialization.js";

export type ProfileImportOptions = {
  readonly sourceArtifact: string;
  readonly maxFunctions?: number;
  readonly sourceDigest?: string;
};

export type PerfettoTraceOptions = ProfileImportOptions & {
  readonly tracePath: string;
  readonly query: string;
  readonly sourceDigest: string;
  readonly executable?: string;
  readonly executableArgs?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

/** Decode a gzip-compressed pprof Profile with the maintained pprof-format binding. */
export function importPprof(input: Uint8Array, options: ProfileImportOptions): ProfileSummaryV1 | ProblemV1 {
  try {
    const sourceDigest = createHash("sha256").update(input).digest("hex");
    const profile = Profile.decode(gunzipSync(input));
    const strings = profile.stringTable.strings;
    const sampleTypes = profile.sampleType.map((sampleType) => ({type: stringAt(strings, numberValue(sampleType.type)), unit: stringAt(strings, numberValue(sampleType.unit))}));
    const functionNames = new Map<number, string>();
    for (const functionValue of profile.function) functionNames.set(numberValue(functionValue.id), stringAt(strings, numberValue(functionValue.name)));
    const locations = new Map<number, string>();
    for (const location of profile.location) {
      const functionId = location.line[0] === undefined ? 0 : numberValue(location.line[0].functionId);
      const name = functionNames.get(functionId);
      if (name !== undefined && name.length > 0) locations.set(numberValue(location.id), name);
    }
    const totals = new Map<string, number>();
    const unit = sampleTypes[0]?.unit ?? "unknown";
    for (const sample of profile.sample) {
      const value = numberValue(sample.value[0] ?? 0);
      const locationName = locations.get(numberValue(sample.locationId[0] ?? 0)) ?? "[unknown]";
      totals.set(locationName, (totals.get(locationName) ?? 0) + value);
    }
    const topFunctions = [...totals.entries()]
      .map(([name, value]) => ({name, value, unit}))
      .sort((left, right) => right.value - left.value || comparePortable(left.name, right.name))
      .slice(0, options.maxFunctions ?? 50);
    const result: ProfileSummaryV1 = {
      schemaVersion: "footgun.profile-summary.v1",
      id: `prof_${sourceDigest.slice(0, 16)}`,
      tool: "pprof",
      sourceArtifact: options.sourceArtifact,
      sourceDigest,
      sampleTypes,
      sampleCount: profile.sample.length,
      locationCount: profile.location.length,
      mappingCount: profile.mapping.length,
      functionCount: profile.function.length,
      topFunctions,
      limitations: ["The summary preserves sampled values and symbol names; it does not replace pprof's full call graph or label semantics."],
    };
    const parsed = Protocol.profileSummary.safeParse(result);
    return parsed.success ? parsed.data : problem("invalid-pprof-summary", "The decoded pprof profile did not satisfy the normalized summary contract.", "Check the profile producer and pprof-format compatibility.");
  } catch (cause: unknown) {
    return problem("pprof-decode-failed", "The artifact is not a readable gzip-compressed pprof Profile.", cause instanceof Error ? cause.message : "Check the pprof artifact and retry.");
  }
}

/** Normalize bounded JSON rows emitted by Perfetto trace-processor queries. */
export function importPerfettoSummary(input: unknown, options: ProfileImportOptions): TraceSummaryV1 | ProblemV1 {
  const parsed = traceProcessorJson.safeParse(input);
  if (!parsed.success) return problem("invalid-perfetto-summary", "The input is not a bounded trace-processor JSON result.", "Run a bounded Perfetto SQL query and export its rows as JSON.");
  const rows = parsed.data.rows.slice(0, options.maxFunctions ?? 1000);
  const columns = parsed.data.columns.length > 0 ? parsed.data.columns : rows.flatMap((row) => Object.keys(row)).filter((value, index, all) => all.indexOf(value) === index).sort();
  const sourceDigest = options.sourceDigest ?? createHash("sha256").update(stableJson(input)).digest("hex");
  const result: TraceSummaryV1 = {schemaVersion: "footgun.trace-summary.v1", id: `trace_${sourceDigest.slice(0, 16)}`, tool: "perfetto", sourceArtifact: options.sourceArtifact, sourceDigest, columns, rows, limitations: ["This is a trace-processor query summary; raw .pftrace packets and unqueried slices are not embedded."]};
  const checked = Protocol.traceSummary.safeParse(result);
  return checked.success ? checked.data : problem("invalid-perfetto-summary", "The trace summary exceeded the normalized scalar-row contract.", "Limit query columns and values to strings, finite numbers, booleans, or null.");
}

/** Run an explicitly installed Perfetto trace processor and import its bounded CSV query result. */
export async function importPerfettoTrace(options: PerfettoTraceOptions): Promise<TraceSummaryV1 | ProblemV1> {
  if (options.query.trim().length === 0 || options.query.length > 10_000) return problem("invalid-perfetto-query", "The Perfetto query is empty or exceeds the bounded query length.", "Provide a bounded SQL query of at most 10,000 characters.");
  const executable = options.executable ?? process.env.FOOTGUN_TRACE_PROCESSOR ?? "trace_processor";
  try {
    const result = await execa(executable, [...(options.executableArgs ?? []), "query", options.tracePath, options.query], {
      reject: false,
      stdin: "ignore",
      timeout: options.timeoutMs ?? 30_000,
      forceKillAfterDelay: 250,
      cleanup: true,
      windowsHide: false,
      maxBuffer: 2_000_000,
      shell: false,
      ...(options.signal === undefined ? {} : {cancelSignal: options.signal}),
    });
    if (result.isCanceled || options.signal?.aborted === true) return problem("trace-processor-cancelled", "The Perfetto trace processor was cancelled.", "Rerun the trace import when the local processor is available.");
    if (result.timedOut) return problem("trace-processor-timeout", "The Perfetto trace processor exceeded its timeout.", "Use a narrower query or increase the bounded timeout deliberately.");
    if (result.exitCode !== 0) return problem("trace-processor-failed", "The Perfetto trace processor returned a nonzero status.", "Inspect the trace processor diagnostics and verify the trace and query.");
    const rows = parseCsvRows(result.stdout);
    if ("code" in rows) return rows;
    const sourceDigest = options.sourceDigest;
    const summary: TraceSummaryV1 = {
      schemaVersion: "footgun.trace-summary.v1",
      id: `trace_${sourceDigest.slice(0, 16)}`,
      tool: "perfetto",
      sourceArtifact: options.sourceArtifact,
      sourceDigest,
      query: options.query,
      columns: rows.columns,
      rows: rows.rows,
      limitations: ["The summary preserves only the bounded CSV query result; raw .pftrace packets and unqueried slices remain in the source artifact."],
    };
    const checked = Protocol.traceSummary.safeParse(summary);
    return checked.success ? checked.data : problem("invalid-perfetto-summary", "The trace processor result exceeded the normalized scalar-row contract.", "Limit query columns and scalar values.");
  } catch (cause: unknown) {
    return problem("trace-processor-unavailable", "The requested Perfetto trace processor could not be started.", cause instanceof Error ? cause.message : "Install trace_processor and set FOOTGUN_TRACE_PROCESSOR if it is not on PATH.");
  }
}

const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const traceProcessorJson = z.union([
  z.array(z.record(z.string(), scalar)).transform((rows) => ({columns: [], rows})),
  z.strictObject({columns: z.array(z.string()), rows: z.array(z.record(z.string(), scalar))}),
]);

const csvRowValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

function parseCsvRows(input: string): {readonly columns: string[]; readonly rows: Array<Record<string, string | number | boolean | null>>} | ProblemV1 {
  try {
    const records: unknown = parseCsv(input, {columns: true, skip_empty_lines: true, trim: true, cast: true, to: 1001});
    if (!Array.isArray(records) || records.length > 1000) return problem("trace-processor-output-too-large", "The Perfetto trace processor returned more than 1,000 rows.", "Add a LIMIT of at most 1,000 rows to the query.");
    const rows: Array<Record<string, string | number | boolean | null>> = [];
    for (const record of records) {
      const parsed = z.record(z.string(), csvRowValue).safeParse(record);
      if (!parsed.success) return problem("invalid-perfetto-csv", "The trace processor returned unsupported CSV scalar values.", "Select only string, numeric, boolean, or null-compatible columns.");
      rows.push(parsed.data);
    }
    const columns = rows.flatMap((row) => Object.keys(row)).filter((value, index, all) => all.indexOf(value) === index);
    return {columns, rows};
  } catch (cause: unknown) {
    return problem("invalid-perfetto-csv", "The trace processor did not return valid bounded CSV.", cause instanceof Error ? cause.message : "Check the trace processor version and query output.");
  }
}

function stringAt(strings: ReadonlyArray<string>, index: number): string {
  return strings[index] ?? "";
}

function numberValue(value: number | bigint): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(number) ? number : 0;
}

function problem(code: string, message: string, recovery: string): ProblemV1 {
  return {schemaVersion: "footgun.problem.v1", code, message, recovery};
}
