import { describe, expect, test } from "bun:test";

const SCANNED_GLOBS = ["README.md", "src/**/*.md", "src/**/*.ts"] as const;
const IGNORED_FILES = new Set([
  "src/osnova/core/scripts/test/stale-docs.test.ts",
]);
const STALE_PATTERNS = [
  /src\/http\/example/,
  /src\/cache\/example/,
  /bin\/http-demo/,
  /src\/osnova\/core\/orm\/example/,
  /src\/osnova\/library\/validation\/example/,
  /@\/cache\b/,
  /@\/http\b/,
  /@\/validation\b/,
  /@\/infra\/redis-cache/,
  /@\/infra\/\*/,
  /from ["']osnova["']/,
] as const;

describe("stale docs and import references", () => {
  test("runtime docs use canonical paths and imports", async () => {
    const failures: string[] = [];
    const seen = new Set<string>();

    for (const glob of SCANNED_GLOBS) {
      for (const file of new Bun.Glob(glob).scanSync({ cwd: process.cwd() })) {
        if (seen.has(file) || IGNORED_FILES.has(file)) {
          continue;
        }
        seen.add(file);
        const text = await Bun.file(file).text();
        for (const pattern of STALE_PATTERNS) {
          if (pattern.test(text)) {
            failures.push(`${file}: ${pattern.source}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
