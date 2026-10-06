import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileBinary } from "../../../cli/build";

// `bun build --compile` inlines the literal `process.env.NODE_ENV` as
// "development". Environment must still read the runtime value, so a compiled
// app without BAZIS_ENV/NODE_ENV runs as production (debug off).
const dir = mkdtempSync(path.join(tmpdir(), "bazis-env-binary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a compiled binary reads the environment at runtime and defaults to production", () => {
  const entry = path.join(dir, "probe.ts");
  const binary = path.join(dir, "probe");
  writeFileSync(entry, `import { Environment } from ${JSON.stringify(path.resolve(import.meta.dir, "../Environment"))};
const environment = Environment.fromProcess();
console.log(JSON.stringify({ name: environment.name, debug: environment.debug }));
`);
  expect(compileBinary(process.execPath, entry, binary)).toBe(0);
  const run = (env: Record<string, string>) => {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "BAZIS_ENV" && key !== "NODE_ENV") clean[key] = value;
    const result = Bun.spawnSync([binary], { cwd: dir, env: { ...clean, ...env }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  expect(run({})).toEqual({ name: "production", debug: false });
  expect(run({ NODE_ENV: "test" })).toEqual({ name: "test", debug: true });
  expect(run({ NODE_ENV: "production", BAZIS_ENV: "development" })).toEqual({ name: "development", debug: true });
}, 60_000);
