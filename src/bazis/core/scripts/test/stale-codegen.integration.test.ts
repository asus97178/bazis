import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Sources changed after codegen: a new controller method with parameters used
// to receive the HttpContext instead of its arguments and fail only on request.
// Now the server refuses to start, and DI errors say to run codegen.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-stale-codegen-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"],
  }, include: ["src/**/*.ts"] }));
  for (const [name, content] of Object.entries(files)) await Bun.write(path.join(root, name), content);
  return root;
}

async function run(root: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

const codegen = path.join(repository, "src/bazis/core/scripts/di-generate.ts");

const server = `import { runApp } from "bazis/core/app";
import { AppModule } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const port = 20000 + Math.floor(Math.random() * 20000);
void runApp(AppModule, { http: { hostname: "127.0.0.1", port } });
const url = "http://127.0.0.1:" + port + "/ping/ann/upper";
for (let i = 0; i < 100 && !(await fetch(url).then(() => true, () => false)); i++) await Bun.sleep(50);
console.log(JSON.stringify(await fetch(url).then((r) => r.json())));
process.exit(0);
`;

const app = (controller: string) => `import { Module } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { ApplicationLifetime } from "bazis/core/kernel";
${controller}
@Module({ controllers: [PingController], exports: [] })
export class AppModule {}
`;

const original = `@Controller("ping") export class PingController {
  @Get(":name") get(name: string) { return { pong: name }; }
}`;
const withMethod = `@Controller("ping") export class PingController {
  @Get(":name") get(name: string) { return { pong: name }; }
  @Get(":name/upper") upper(name: string) { return { pong: name.toUpperCase() }; }
  @Get("health/check") check() { return { ok: true }; }
}`;
const withConstructor = `@Controller("ping") export class PingController {
  constructor(private readonly lifetime: ApplicationLifetime) {}
  @Get(":name") get(name: string) { return { pong: name, started: this.lifetime.isStarted }; }
}`;

test("a controller method added after codegen stops the start with a clear error", async () => {
  const root = await project({ "src/index.ts": app(original), "server.ts": server });
  const generated = await run(root, [codegen]);
  expect(generated.exit, generated.output).toBe(0);

  await Bun.write(path.join(root, "src/index.ts"), app(withMethod));
  const stale = await run(root, ["server.ts"]);
  expect(stale.output).toContain("PingController.upper has parameters but no generated argument bindings");
  expect(stale.output).toContain("Run `bazis codegen`");

  const regenerated = await run(root, [codegen]);
  expect(regenerated.exit, regenerated.output).toBe(0);
  const fresh = await run(root, ["server.ts"]);
  expect(JSON.parse(fresh.last), fresh.output).toEqual({ pong: "ANN" });
}, 60_000);

test("a constructor added after codegen fails DI validation with a codegen hint", async () => {
  const root = await project({ "src/index.ts": app(original), "server.ts": server });
  expect((await run(root, [codegen])).exit).toBe(0);
  await Bun.write(path.join(root, "src/index.ts"), app(withConstructor));
  const stale = await run(root, ["server.ts"]);
  expect(stale.output).toContain('Class provider "PingController" requires at least 1 constructor deps, but only 0 declared.');
  expect(stale.output).toContain("run `bazis codegen`");
}, 60_000);
