import {expect, it} from "vitest";
import * as fc from "fast-check";
import {scanSource} from "./scanners/structural.js";
import {comparePortable, portablePath} from "./paths.js";
import {Protocol} from "./protocol/index.js";

it("keeps finding identities stable across repeated scans", () => {
  fc.assert(
    fc.property(fc.array(fc.string({minLength: 0, maxLength: 60}), {maxLength: 12}), (lines) => {
      const source = lines.join("\n");
      const first = scanSource("fixtures/generated.ts", source).findings;
      const second = scanSource("fixtures/generated.ts", source).findings;
      expect(second).toEqual(first);
      expect(new Set(first.map((finding) => finding.id)).size).toBe(first.length);
      expect(first.every((finding) => /^fg_[a-f0-9]{16}$/.test(finding.id))).toBe(true);
    }),
  );
});

it("keeps structural findings uniquely ordered and serializable for arbitrary source", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "for (const item of items) { items.includes(item); }",
          "while (ready) { values.sort(); }",
          "const value = 'for (x of y)'",
          "// for (x of y)",
        ),
        {maxLength: 20},
      ),
      (lines) => {
        const findings = scanSource("src/fixture.ts", lines.join("\n")).findings;
        const keys = findings.map(
          (finding) => `${finding.location.path}\0${finding.location.startLine}\0${finding.ruleId}`,
        );
        expect(new Set(keys).size).toBe(keys.length);
        expect(findings).toEqual(
          [...findings].sort(
            (left, right) =>
              comparePortable(left.location.path, right.location.path) ||
              left.location.startLine - right.location.startLine ||
              comparePortable(left.ruleId, right.ruleId),
          ),
        );
        for (const finding of findings) expect(Protocol.finding.safeParse(finding).success).toBe(true);
      },
    ),
  );
});

it("normalizes repository paths without introducing parent traversal", () => {
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("src", "nested", "fixture.ts", ".", ".."), {minLength: 1, maxLength: 8}),
      fc.boolean(),
      (parts, windowsSeparators) => {
        const input = parts.join(windowsSeparators ? "\\" : "/");
        const normalized = portablePath(input);
        expect(normalized).not.toContain("\\");
        expect(portablePath(normalized)).toBe(normalized);
        expect(normalized).not.toContain("//");
      },
    ),
  );
});
