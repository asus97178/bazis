import path from "node:path";
import { describe, expect, test } from "bun:test";

interface PackageJson {
  readonly scripts: Record<string, string>;
}

async function readPackageJson(): Promise<PackageJson> {
  return (await Bun.file(path.join(process.cwd(), "package.json")).json()) as PackageJson;
}

describe("binary build targets", () => {
  test("split app and framework CLI binary outputs", async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts["build:bin"]).toContain("build:bin:app");
    expect(pkg.scripts["build:bin"]).toContain("build:bin:cli");
    expect(pkg.scripts["build:bin:app"]).toContain("scripts/build-bin.ts src/index.ts bin/osnova-app");
    expect(pkg.scripts["build:bin:cli"]).toContain("scripts/build-bin.ts src/osnova/cli/main.ts bin/osnv");
    expect(pkg.scripts["prebuild:bin"]).toBe("bun run di:generate");
    expect(pkg.scripts.prebuild).toBe("bun run di:generate");
    expect(pkg.scripts["bin:run"]).toBe("OSNV_ENV=production ./bin/osnova-app");
    expect(pkg.scripts["bin:run:cli"]).toBe("./bin/osnv");
  });
});
