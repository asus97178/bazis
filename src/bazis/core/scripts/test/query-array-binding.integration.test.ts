import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Query arrays: `tag: string[]` takes every ?tag= value. Before, codegen
// stopped with "no type annotation usable for conventions".
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

test("query arrays are bound, converted and described in OpenAPI", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-query-arrays-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), `import { Module } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
@Controller("tasks") export class TasksController {
  @Get() list(flag: Array<boolean>, ids: readonly number[], tag: string[] = [], status?: number[]) {
    return { tag, status: status ?? null, flag, ids };
  }
}
@Module({ controllers: [TasksController], exports: [] }) export class AppModule {}
`);
  await Bun.write(path.join(root, "probe.ts"), `import { startTestApp } from "bazis/core/testing";
import { AppModule } from "./src/index";
const app = await startTestApp(AppModule, { http: { docs: true } });
const get = async (query: string) => { const r = await app.fetch("/tasks" + query); return [r.status, await r.json()]; };
const spec = await (await app.fetch("/docs/openapi.json")).json();
const params = spec.paths["/tasks"].get.parameters.map((p: any) => [p.name, p.required, p.schema]);
console.log(JSON.stringify({
  many: await get("?tag=a&tag=b&status=1&status=2&flag=true&flag=0&ids=7"),
  none: await get(""),
  bad: await get("?status=abc"),
  params,
}));
await app.stop();
`);
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);
  const bindings = await Bun.file(path.join(root, "src/generated/bazis/bindings.ts")).text();
  expect(bindings).toContain(`{"source":"query","name":"tag","optional":true,"array":true}`);
  expect(bindings).toContain(`{"source":"query","name":"status","type":"number","optional":true,"array":true}`);

  const probe = await run(root, ["probe.ts"]);
  expect(probe.exit, probe.output).toBe(0);
  const result = JSON.parse(probe.last);
  expect(result.many).toEqual([200, { tag: ["a", "b"], status: [1, 2], flag: [true, false], ids: [7] }]);
  expect(result.none).toEqual([200, { tag: [], status: null, flag: [], ids: [] }]);
  expect(result.bad).toEqual([400, { error: 'Parameter "status" must be of type number, got: "abc"' }]);
  expect(result.params).toEqual([
    ["flag", false, { type: "array", items: { type: "boolean" } }],
    ["ids", false, { type: "array", items: { type: "number" } }],
    ["tag", false, { type: "array", items: { type: "string" } }],
    ["status", false, { type: "array", items: { type: "number" } }],
  ]);
}, 60_000);
