import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A module registers services only in the agreed forms; codegen refuses the rest.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function generate(source: string): Promise<{ exit: number; output: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-provider-form-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"],
  }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), source);
  const child = Bun.spawn([process.execPath, path.join(repository, "src/bazis/core/scripts/di-generate.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err };
}

const services = `import { DI, Module, createToken, scoped, singleton, singletonAsyncFactory, singletonFactory, singletonValue, transient } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { OnEvent, createEventToken, withEventSubscribers } from "bazis/core/kernel";
export const AppName = createToken<string>("AppName");
export interface Db { readonly url: string }
export const Db = createToken<Db>("Db");
export abstract class IClock { abstract now(): string }
export class Clock extends IClock { now() { return "12:00"; } }
export class Greeter { constructor(private readonly clock: IClock) {} }
export class Ids {}
export const PING = createEventToken<{}>("ping");
export class Audit { @OnEvent(PING) on() {} }
@Controller("hello") export class HelloController { constructor(private readonly greeter: Greeter) {} @Get() get() { return {}; } }
`;

test("the agreed forms pass", async () => {
  const result = await generate(`${services}
@Module({
  providers: [
    singleton(IClock, Clock),
    scoped(Greeter),
    transient(Ids),
    singletonValue(AppName, "app"),
    singletonAsyncFactory(Db, [AppName], async (name: string) => ({ url: name })),
    scoped(Audit),
    ...withEventSubscribers(Audit),
  ],
  controllers: [HelloController],
  exports: [],
})
export class AppModule {}
`);
  expect(result.exit, result.output).toBe(0);
}, 60_000);

test("a dependency list, a factory, a DI.* provider or a bound class stop codegen with the agreed forms", async () => {
  const result = await generate(`${services}
@Module({
  providers: [
    scoped(Greeter, Greeter, [IClock]),
    singletonFactory(Ids, [], () => new Ids()),
    DI.singleton(DI.classProvider(IClock, Clock)),
  ],
  controllers: [DI.bindDeps(HelloController, Greeter)],
  exports: [],
})
export class AppModule {}
`);
  expect(result.exit).not.toBe(0);
  expect(result.output).toContain('providers of AppModule: "scoped(Greeter, Greeter, [IClock])" passes a dependency list. Remove it: codegen reads the constructor.');
  expect(result.output).toContain('providers of AppModule: "singletonFactory(Ids, [], () => new Ids())" is not an agreed registration.');
  expect(result.output).toContain('providers of AppModule: "DI.singleton(DI.classProvider(IClock, Clock))" is not an agreed registration.');
  expect(result.output).toContain('controllers of AppModule: "DI.bindDeps(HelloController, Greeter)" — list the class itself');
  expect(result.output).toContain("Agreed forms: scoped(IService, Service), singleton(IService, Service), transient(IService, Service) (or the class alone), singletonValue(TOKEN, value), singletonAsyncFactory(TOKEN, [deps], async factory) or ...withEventSubscribers(Class).");
}, 60_000);

// 0.138.0: Tools made by a function come from defineTool; an application writes its own factory.
const tools = `import { Tool, defineTool, type ToolSet } from "bazis/core/agent";
@Tool({ name: "hello.say", description: "Says hello.", callers: ["agent"] }) export class SayTool { constructor(private readonly greeter: Greeter) {} execute() { return {}; } }
export const ping = defineTool({ name: "hello.ping", description: "Answers.", callers: ["agent"], execute: () => ({}) });
export function exportTools(formats: readonly string[]): ToolSet {
  return Object.fromEntries(formats.map((format) => [format, defineTool({ name: "hello.export." + format, description: "Exports.", callers: ["agent"], execute: () => ({}) })]));
}
export const more = [defineTool({ name: "hello.more", description: "More.", callers: ["agent"], execute: () => ({}) })];
`;

test("tools take classes, Tools of defineTool, sets of them and calls that make them", async () => {
  const result = await generate(`${services}${tools}
@Module({
  providers: [singleton(IClock, Clock), scoped(Greeter)],
  tools: [SayTool, ping, exportTools(["pdf", "csv"]), ...more, { inline: defineTool({ name: "hello.inline", description: "Inline.", callers: ["agent"], execute: () => ({}) }) }],
  exports: [],
})
export class AppModule {}
`);
  expect(result.exit, result.output).toBe(0);
}, 60_000);

test("a tool that is neither a class nor made by defineTool stops codegen", async () => {
  const result = await generate(`${services}${tools}
import { DI } from "bazis/core/di/lowLevel";
const made = (): object[] => [];
@Module({
  providers: [singleton(IClock, Clock), scoped(Greeter)],
  tools: [DI.bindDeps(SayTool, Greeter), ...made()],
  exports: [],
})
export class AppModule {}
`);
  expect(result.exit).not.toBe(0);
  expect(result.output).toContain('tools of AppModule: "DI.bindDeps(SayTool, Greeter)" — list the class itself; its constructor dependencies come from codegen. A Tool made by a function comes from defineTool(...).');
  expect(result.output).toContain('tools of AppModule: "...made()" — list the class itself');
}, 60_000);
