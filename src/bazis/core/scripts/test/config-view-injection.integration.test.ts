import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A constructor parameter typed ConfigView<T> binds to the token of the one
// defineConfig<T>(...) declaration, without an explicit deps list.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-config-view-"));
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

test("ConfigView<T> is injected by type, also through an inherited constructor", async () => {
  const root = await project({
    // "a.*" sorts before "z.*": the service is read before its declaration.
    "src/a.service.ts": `import type { ConfigView } from "bazis/core/kernel";
import type { GreetingConfig } from "./z.config";
export class GreetingService {
  constructor(private readonly config: ConfigView<GreetingConfig>) {}
  greet(name: string) { return this.config.get("prefix") + ", " + name; }
}
export class LoudGreetingService extends GreetingService {}
`,
    "src/z.config.ts": `import { defineConfig } from "bazis/core/kernel";
export interface GreetingConfig { prefix: string }
export const greetingConfig = defineConfig<GreetingConfig>("greeting", { default: { prefix: "Hello" } });
`,
    "src/index.ts": `import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { GreetingService, LoudGreetingService } from "./a.service";
import { greetingConfig } from "./z.config";
@Controller("greet") export class GreetController {
  constructor(private readonly greetings: GreetingService, private readonly loud: LoudGreetingService) {}
  @Get(":name") get(name: string) { return { plain: this.greetings.greet(name), loud: this.loud.greet(name) }; }
}
@Module({ config: greetingConfig, providers: [scoped(GreetingService), scoped(LoudGreetingService)], controllers: [GreetController], exports: [] })
export class AppModule {}
`,
    "server.ts": `import { runApp } from "bazis/core/app";
import { AppModule } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
// A port the OS has just handed out, not a random guess that another process may hold.
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
void runApp(AppModule, { http: { hostname: "127.0.0.1", port } });
const url = "http://127.0.0.1:" + port + "/greet/Ann";
// A loaded CI runner can take several seconds to start the app: wait up to 20.
for (let i = 0; i < 400 && !(await fetch(url).then(() => true, () => false)); i++) await Bun.sleep(50);
console.log(JSON.stringify(await fetch(url).then((r) => r.json())));
process.exit(0);
`,
  });
  const generated = await run(root, [codegen]);
  expect(generated.exit, generated.output).toBe(0);
  const deps = await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text();
  expect(deps.match(/"Config:greeting"/g)?.length).toBe(2);

  const byDefault = await run(root, ["server.ts"]);
  expect(JSON.parse(byDefault.last), byDefault.output).toEqual({ plain: "Hello, Ann", loud: "Hello, Ann" });
  const overridden = await run(root, ["server.ts"], { BAZIS_GREETING__PREFIX: "Hey" });
  expect(JSON.parse(overridden.last), overridden.output).toEqual({ plain: "Hey, Ann", loud: "Hey, Ann" });
}, 60_000);

test("an unknown or ambiguous ConfigView<T> stops codegen with a precise error", async () => {
  const service = `import type { ConfigView } from "bazis/core/kernel";
import { Module, scoped } from "bazis/core/di";
export interface Shared { value: string }
export class Reader { constructor(readonly config: ConfigView<Shared>) {} }
@Module({ providers: [scoped(Reader)], exports: [] }) export class AppModule {}
`;
  const unknown = await project({ "src/index.ts": service });
  const missing = await run(unknown, [codegen]);
  expect(missing.exit).not.toBe(0);
  expect(missing.output).toContain(`BAZIS_DI_CONFIG_UNKNOWN`);
  expect(missing.output).toContain(`no defineConfig<Shared>(...) declaration was found`);

  const twice = await project({ "src/index.ts": `${service}
import { defineConfig } from "bazis/core/kernel";
export const first = defineConfig<Shared>("first", { default: { value: "a" } });
export const second = defineConfig<Shared>("second", { default: { value: "b" } });
` });
  const ambiguous = await run(twice, [codegen]);
  expect(ambiguous.exit).not.toBe(0);
  expect(ambiguous.output).toContain(`BAZIS_DI_CONFIG_AMBIGUOUS`);
  expect(ambiguous.output).toContain(`"first", "second"`);
}, 60_000);

test("ConfigView<typeof config>: the settings are described once, by their defaults", async () => {
  const root = await project({
    "src/a.service.ts": `import type { ConfigView } from "bazis/core/kernel";
import type { greetingConfig, plainConfig } from "./z.config";
export class GreetingService {
  constructor(private readonly config: ConfigView<typeof greetingConfig>, private readonly plain: ConfigView<typeof plainConfig>) {}
  greet(name: string) {
    const prefix: string = this.config.get("prefix");
    const times: number = this.config.get("times");
    const mood: "calm" | "loud" = this.config.get("mood");
    const hosts: readonly string[] = this.config.get("hosts");
    return [prefix + ", " + name, times, mood, hosts.length, this.plain.get("suffix")].join("|");
  }
}
export class LoudGreetingService extends GreetingService {}
`,
    "src/z.config.ts": `import { configEnum, configList, defineConfig } from "bazis/core/kernel";
export const greetingConfig = defineConfig("greeting", { default: { prefix: "Hello", times: 2, mood: configEnum(["calm", "loud"], "calm"), hosts: configList(["a", "b"]) } });
export const plainConfig = defineConfig({ default: { suffix: "!" } });
`,
    "src/index.ts": `import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { GreetingService, LoudGreetingService } from "./a.service";
import { greetingConfig, plainConfig } from "./z.config";
@Controller("greet") export class GreetController {
  constructor(private readonly greetings: GreetingService, private readonly loud: LoudGreetingService) {}
  @Get(":name") get(name: string) { return { plain: this.greetings.greet(name), loud: this.loud.greet(name) }; }
}
@Module({ config: [greetingConfig, plainConfig], providers: [scoped(GreetingService), scoped(LoudGreetingService)], controllers: [GreetController], exports: [] })
export class AppModule {}
`,
    "server.ts": `import { runApp } from "bazis/core/app";
import { AppModule } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = probe.port;
probe.stop(true);
void runApp(AppModule, { http: { hostname: "127.0.0.1", port } });
const url = "http://127.0.0.1:" + port + "/greet/Ann";
for (let i = 0; i < 400 && !(await fetch(url).then(() => true, () => false)); i++) await Bun.sleep(50);
console.log(JSON.stringify(await fetch(url).then((r) => r.json())));
process.exit(0);
`,
  });
  const generated = await run(root, [codegen]);
  expect(generated.exit, generated.output).toBe(0);
  const deps = await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text();
  expect(deps.match(/"Config:greeting"/g)?.length).toBe(2);
  expect(deps.match(/"Config:default"/g)?.length).toBe(2);

  const byDefault = await run(root, ["server.ts"]);
  expect(JSON.parse(byDefault.last), byDefault.output).toEqual({ plain: "Hello, Ann|2|calm|2|!", loud: "Hello, Ann|2|calm|2|!" });
  const overridden = await run(root, ["server.ts"], { BAZIS_GREETING__PREFIX: "Hey", BAZIS_GREETING__MOOD: "loud", BAZIS_GREETING__HOSTS: "x" });
  expect(JSON.parse(overridden.last).plain, overridden.output).toBe("Hey, Ann|2|loud|1|!");
}, 60_000);

test("ConfigView<typeof x> of something that is not a declaration with a literal section stops codegen", async () => {
  const root = await project({ "src/index.ts": `import { defineConfig, type ConfigView } from "bazis/core/kernel";
import { Module, scoped } from "bazis/core/di";
export interface Shape { value: string }
export const typed = defineConfig<Shape>("typed", { default: { value: "a" } });
export class Reader { constructor(readonly config: ConfigView<typeof typed>) {} }
@Module({ config: typed, providers: [scoped(Reader)], exports: [] }) export class AppModule {}
` });
  const result = await run(root, [codegen]);
  expect(result.exit).not.toBe(0);
  expect(result.output).toContain("BAZIS_DI_CONFIG_UNKNOWN");
  expect(result.output).toContain("without a type argument");
}, 60_000);
