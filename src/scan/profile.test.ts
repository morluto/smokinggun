import {expect, it} from "vitest";
import {isAuxiliarySourcePath} from "./profile.js";

it.each(["foo.test.ts", "foo_spec.rb", "foo_test.go", "test_foo.py", "TestFoo.java", "FooTests.cs"])(
  "recognizes %s as an auxiliary source path",
  (path) => {
    expect(isAuxiliarySourcePath(path)).toBe(true);
  },
);

it.each(["contest.ts", "latest.ts", "src/contest.ts"])('does not classify "%s" as an auxiliary source path', (path) => {
  expect(isAuxiliarySourcePath(path)).toBe(false);
});

it.each(["testing.ts", "special.py", "specification.go"])('keeps "%s" in the runtime profile', (path) => {
  expect(isAuxiliarySourcePath(path)).toBe(false);
});
