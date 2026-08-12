import {describe, expect, it} from "vitest";
import {redactSensitive} from "./environment.js";

describe("adapter diagnostic redaction", () => {
  it("removes complete bearer and basic authorization credentials", () => {
    expect(redactSensitive("Authorization: Bearer abc.def.ghi next")).toBe("Authorization: [REDACTED] next");
    expect(redactSensitive("authorization=Basic dXNlcjpwYXNz, next")).toBe("authorization=[REDACTED], next");
  });
});
