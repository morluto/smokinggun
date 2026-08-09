import {expect, it} from "vitest";
import {parsePackageMetadata} from "./tool-identity.js";

it("parses the package version instead of trusting module metadata", () => {
  expect(parsePackageMetadata({version: "2.0.0"})).toEqual({version: "2.0.0"});
  expect(() => parsePackageMetadata({version: ""})).toThrow();
  expect(parsePackageMetadata({version: "2.0.0", extra: true})).toMatchObject({version: "2.0.0"});
});
