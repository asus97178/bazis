import { describe, expect, test } from "bun:test";

describe("runtime examples boundary", () => {
  test("runnable examples stay out of framework runtime folders", () => {
    const matches = [...new Bun.Glob("src/osnv/**/example.ts").scanSync({ cwd: process.cwd() })].sort();
    expect(matches).toEqual([]);
  });
});
