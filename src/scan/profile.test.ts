import {expect, it} from "vitest";
import {isAuxiliarySourcePath, isTestSourcePath} from "./profile.js";

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

it.each(["foo.test.ts", "foo_spec.rb", "foo_test.go", "test_foo.py", "TestFoo.java", "FooTests.cs"])(
  "recognizes %s as a test source path for inventory",
  (path) => {
    expect(isTestSourcePath(path)).toBe(true);
  },
);

it.each(["docs/guide.ts", "contest.ts", "testing.ts", "special.py", "specification.go"])(
  'does not classify "%s" as a test source path for inventory',
  (path) => {
    expect(isTestSourcePath(path)).toBe(false);
  },
);
