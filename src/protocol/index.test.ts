import {describe, expect, it} from "vitest";
import {parseScanReport, Protocol} from "./index.js";

describe("protocol contracts", () => {
  it("rejects unknown fields in a scan report", () => {
    const result = Protocol.scanReport.safeParse({schemaVersion: "footgun.scan-report.v1", extra: true});
    expect(result.success).toBe(false);
  });

  it("returns a typed problem for an unsupported artifact", () => {
    const result = parseScanReport({schemaVersion: "footgun.scan-report.v2"});
    expect("_tag" in result).toBe(true);
    if ("_tag" in result) expect(result.code).toBe("invalid-scan-report");
  });
});
