import path from "node:path";
import { describe, expect, test } from "bun:test";

interface PackageJson {
  readonly scripts: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJson> {
  return (await Bun.file(path.join(process.cwd(), "package.json")).json()) as PackageJson;
}

describe("binary build targets", () => {
  test("the framework repository compiles only the bazis CLI binary, after codegen", async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts["build:bin"]).toContain("scripts/build-bin.ts src/bazis/cli/main.ts bin/bazis");
    expect(pkg.scripts["prebuild:bin"]).toBe("bun run di:generate");
    expect(pkg.scripts.prebuild).toBe("bun run di:generate");
  });
});
