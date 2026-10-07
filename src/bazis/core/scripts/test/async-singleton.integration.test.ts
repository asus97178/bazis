import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// An async singleton injected through a constructor used to fail every request
// with AsyncResolutionRequiredError; now it is created at startup. A constructor
// parameter of a plain type (string) used to pass codegen silently.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-async-singleton-"));
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

const services = (factory: string) => `import { createToken, type HostedService } from "bazis/core/di";
export interface Db { readonly connectedAt: string }
export const Db = createToken<Db>("Db");
export async function connect(): Promise<Db> { ${factory} }
export class Warmup implements HostedService {
  constructor(private readonly db: Db) {}
  start() { console.log("worker sees " + this.db.connectedAt); }
  stop() {}
}
`;
const index = `import { Module, singletonAsyncFactory } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { Db, Warmup, connect } from "./services";
@Controller("db") export class DbController {
  constructor(private readonly db: Db) {}
  @Get() get() { return { connectedAt: this.db.connectedAt }; }
}
@Module({ providers: [singletonAsyncFactory(Db, [] as const, connect)], background: [Warmup], controllers: [DbController], exports: [] })
export class AppModule {}
`;
const server = `import { runApp } from "bazis/core/app";
import { AppModule } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const port = 20000 + Math.floor(Math.random() * 20000);
const running = runApp(AppModule, { http: { hostname: "127.0.0.1", port } });
const url = "http://127.0.0.1:" + port + "/db";
for (let i = 0; i < 60 && !(await fetch(url).then(() => true, () => false)); i++) await Bun.sleep(50);
const answer = await fetch(url).then((r) => r.json(), () => "no server");
console.log(JSON.stringify(answer));
console.log("exit=" + (await Promise.race([running, Bun.sleep(100).then(() => "running")])));
process.exit(0);
`;

test("an async singleton is created at startup and injected into controllers and hosted services", async () => {
  const root = await project({
    "src/services.ts": services(`await Bun.sleep(20); return { connectedAt: "startup" };`),
    "src/index.ts": index,
    "server.ts": server,
  });
  const generated = await run(root, [codegen]);
  expect(generated.exit, generated.output).toBe(0);
  const served = await run(root, ["server.ts"]);
  expect(served.output).toContain("worker sees startup");
  expect(served.output).toContain('{"connectedAt":"startup"}');
  expect(served.output).toContain("exit=running");
}, 60_000);

test("a failing async factory stops the start instead of failing every request", async () => {
  const root = await project({
    "src/services.ts": services(`throw new Error("database is unreachable");`),
    "src/index.ts": index,
    "server.ts": server,
  });
  expect((await run(root, [codegen])).exit).toBe(0);
  const served = await run(root, ["server.ts"]);
  expect(served.output).toContain("database is unreachable");
  expect(served.output).toContain('"no server"');
  expect(served.output).toContain("exit=1");
}, 60_000);

test("a constructor parameter of a plain type stops codegen; explicit deps still work", async () => {
  const greeter = (registration: string) => `import { Module, createToken, scoped, singletonValue } from "bazis/core/di";
export type Prefix = string;
export const Prefix = createToken<Prefix>("Prefix");
export class Greeter { constructor(private readonly prefix: string) {} }
@Module({ providers: [singletonValue(Prefix, "Hi"), ${registration}], exports: [] })
export class AppModule {}
`;
  const inferred = await project({ "src/index.ts": greeter("scoped(Greeter)") });
  const failed = await run(inferred, [codegen]);
  expect(failed.exit).not.toBe(0);
  expect(failed.output).toContain('BAZIS_DI_DEPENDENCY_UNKNOWN');
  expect(failed.output).toContain('constructor parameter 1 "prefix" of "Greeter" has type "string", which cannot be injected');

  const explicit = await project({ "src/index.ts": greeter("scoped(Greeter, Greeter, [Prefix] as const)") });
  const passed = await run(explicit, [codegen]);
  expect(passed.exit, passed.output).toBe(0);
}, 60_000);
