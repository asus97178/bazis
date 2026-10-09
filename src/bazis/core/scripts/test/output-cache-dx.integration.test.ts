import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Output cache DX: memory() takes named policies; a hit carries Age; an
// @OutputCache route without a cache module is reported at startup instead of
// silently running the action on every request.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

test("memory() policies, Age on hits and the missing cache module warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-output-cache-dx-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), `import { Module } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { OutputCache } from "bazis/core/cache";
let calls = 0;
@Controller("tasks")
export class TasksController {
  @Get() @OutputCache({ policy: "catalog" }) getAll() { calls += 1; return { calls }; }
  @Get("off") @OutputCache({ seconds: 60, enabled: false }) off() { return {}; }
}
@Module({ controllers: [TasksController], exports: [] }) export class AppModule {}
`);
  await Bun.write(path.join(root, "probe.ts"), `import { memory } from "bazis/core/cache";
import { startTestApp } from "bazis/core/testing";
import { AppModule } from "./src/index";
const cached = await startTestApp(AppModule, { cache: memory({ policies: { catalog: { seconds: 60, clientCache: { public: true, maxAge: 30 } } } }) });
const first = await cached.fetch("/tasks");
const firstBody = await first.json();
await Bun.sleep(1100);
const second = await cached.fetch("/tasks");
const result = {
  first: [firstBody, first.headers.get("age"), first.headers.get("cache-control")],
  second: [await second.json(), second.headers.get("age")],
};
await cached.stop();
const bare = await startTestApp(AppModule);
const a = await (await bare.fetch("/tasks")).json();
const b = await (await bare.fetch("/tasks")).json();
await bare.stop();
console.log(JSON.stringify({ ...result, bare: [a, b] }));
`);
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);
  const probe = await run(root, ["probe.ts"]);
  expect(probe.exit, probe.output).toBe(0);
  expect(JSON.parse(probe.last)).toEqual({
    first: [{ calls: 1 }, null, "public, max-age=30"],
    second: [{ calls: 1 }, "1"],
    bare: [{ calls: 2 }, { calls: 3 }],
  });
  const warnings = probe.output.split("\n").filter((line) => line.includes("has no effect"));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(
    "[cache] @OutputCache on TasksController.getAll has no effect: no cache module is installed, so every request runs the action. Add `cache: memory()` to the runApp options.",
  );
}, 60_000);
