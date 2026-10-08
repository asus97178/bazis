import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A v2 controller built on v1 by inheritance. Before, an override with its own
// route decorator failed at startup with a duplicate route, and an override
// without decorators received HttpContext instead of the route parameter.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

test("inherited routes are bound; a subclass's route decorator replaces the base's", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-controller-inheritance-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/NotesV1.controller.ts"), `import { ApiVersion, Controller, Get, HttpCode, HttpContext } from "bazis/core/http";
@Controller("notes") @ApiVersion("1")
export class NotesV1Controller {
  @Get() getAll(limit = 10) { return { v: 1, limit }; }
  @Get(":id") getById(id: string) { return { v: 1, id }; }
  @Get(":id/text") text(id: string, ctx: HttpContext) { return { v: 1, id, path: ctx.path }; }
  @Get(":id/tags") @HttpCode(203) tags(id: string) { return { v: 1, id }; }
}
`);
  await Bun.write(path.join(root, "src/index.ts"), `import { Module } from "bazis/core/di";
import { ApiVersion, Controller, Get } from "bazis/core/http";
import { NotesV1Controller } from "./NotesV1.controller";
@Controller("notes") @ApiVersion("2")
export class NotesV2Controller extends NotesV1Controller {
  @Get(":noteId") override getById(noteId: string) { return { v: 2, noteId }; }
  override text(id: string) { return { v: 2, id }; }
  @Get(":id/labels") override tags(id: string) { return { v: 2, id }; }
}
@Controller("notes") @ApiVersion("3")
export class NotesV3Controller extends NotesV2Controller {}
@Module({ controllers: [NotesV1Controller, NotesV2Controller, NotesV3Controller], exports: [] }) export class AppModule {}
`);
  await Bun.write(path.join(root, "probe.ts"), `import { startTestApp } from "bazis/core/testing";
import { AppModule } from "./src/index";
const app = await startTestApp(AppModule);
const get = async (url: string) => { const r = await app.fetch(url); return [r.status, await r.json()]; };
const result: Record<string, unknown> = {};
for (const url of ["/v1/notes?limit=5", "/v2/notes?limit=5", "/v1/notes/7", "/v2/notes/7", "/v3/notes/7",
  "/v1/notes/7/text", "/v2/notes/7/text", "/v2/notes/7/labels", "/v2/notes/7/tags", "/v1/notes/7/tags"]) result[url] = await get(url);
console.log(JSON.stringify(result));
await app.stop();
`);
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);

  const probe = await run(root, ["probe.ts"]);
  expect(probe.exit, probe.output).toBe(0);
  expect(JSON.parse(probe.last)).toEqual({
    "/v1/notes?limit=5": [200, { v: 1, limit: 5 }],
    "/v2/notes?limit=5": [200, { v: 1, limit: 5 }],
    "/v1/notes/7": [200, { v: 1, id: "7" }],
    "/v2/notes/7": [200, { v: 2, noteId: "7" }],
    "/v3/notes/7": [200, { v: 2, noteId: "7" }],
    "/v1/notes/7/text": [200, { v: 1, id: "7", path: "/v1/notes/7/text" }],
    "/v2/notes/7/text": [200, { v: 2, id: "7" }],
    "/v2/notes/7/labels": [203, { v: 2, id: "7" }],
    "/v2/notes/7/tags": [404, { error: "Not Found" }],
    "/v1/notes/7/tags": [203, { v: 1, id: "7" }],
  });
}, 60_000);
