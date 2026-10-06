import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const repo = process.cwd();
const generator = path.join(repo, "src/bazis/core/scripts/di-generate.ts");

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-di-constructors-"));
  await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
  const config = {
    compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
      noEmit: true,
      paths: { "bazis/*": [path.join(repo, "src/bazis/*")], "@/*": [path.join(repo, "src/bazis/*")] },
    },
    include: ["src/**/*.ts"],
  };
  for (const [name, content] of Object.entries({
    "tsconfig.json": JSON.stringify(config),
    "bazis.config.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }),
    ...files,
  })) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await Bun.write(file, content);
  }
  return root;
}

async function run(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, stdout, stderr };
}

async function succeeds(root: string, ...args: string[]): Promise<string> {
  const result = await run(root, ...args);
  expect(result.exit, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

async function cleanup(root: string): Promise<void> {
  // Bun --compile may copy the qualified launcher's immutable flag to scratch files.
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await cleanup(file);
    else if (process.platform === "darwin" && entry.isFile() && entry.name.endsWith(".bun-build")) {
      const child = Bun.spawn(["/usr/bin/chflags", "nouchg", file], { stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(0);
    }
  }
  await rm(root, { recursive: true, force: true });
}

test("codegen binds inherited and generic constructors to each concrete identity in source and binary", async () => {
  const root = await project({
    "src/a.ts": 'export class Dependency { readonly value = "A"; }',
    "src/b.ts": 'export class Dependency { readonly value = "B"; }',
    "src/contract.ts": 'import { createToken } from "bazis/core/di"; export type IContract = { value: string }; export const IContract = createToken<IContract>("IContract");',
    "src/services.ts": `import type { Lazy } from "bazis/core/di";
import { Dependency as A } from "./a";
import { Dependency as B } from "./b";
import type { IContract } from "./contract";
export abstract class BaseService { constructor(readonly dependency: A, readonly lazy: Lazy<A>, readonly optional = "default") {} }
class ChildService extends BaseService {}
export { ChildService as Inherited };
export default class Grandchild extends ChildService {}
export class GenericBase<T> { constructor(readonly dependency: T, readonly lazy: Lazy<T>) {} }
export class GenericMiddle<T> extends GenericBase<T> {}
export class GenericChild extends GenericMiddle<B> {}
class LocalBase { constructor(readonly dependency: A) {} }
export class LocalChild extends LocalBase {}
class DefaultBase { constructor(readonly dependency: A = new A(), readonly second: B) {} }
export class DefaultChild extends DefaultBase {}
abstract class ContractBase { constructor(readonly dependency: IContract) {} }
export class ContractChild extends ContractBase {}
export class OwnConstructor extends GenericBase<B> { constructor(dependency: A) { super(new B(), { value: new B(), isCreated: true }); this.own = dependency; } readonly own: A; }
export class OwnEmpty extends BaseService { constructor() { super(new A(), { value: new A(), isCreated: true }); } }
export class Explicit extends BaseService {}
export class Bound extends BaseService {}
export class Override extends A { override readonly value = "A"; }
`,
    "src/index.ts": `import { createContainer, DI, singleton, singletonValue, lazyDependency } from "bazis/core/di";
import { Dependency as A } from "./a";
import { Dependency as B } from "./b";
import { IContract } from "./contract";
import Grandchild, { Inherited, GenericChild, LocalChild, DefaultChild, ContractChild, OwnConstructor, OwnEmpty, Explicit, Bound, Override } from "./services";
// Register providers before bootstrap; late normalization must remain supported.
DI.bindDeps(Bound, Override, lazyDependency(Override));
const providers = [singleton(A), singleton(B), singleton(Override), singleton(Inherited), singleton(Grandchild), singleton(GenericChild), singleton(LocalChild), singleton(DefaultChild), singleton(ContractChild), singletonValue(IContract, {value: "contract"}), singleton(OwnConstructor), singleton(OwnEmpty), singleton(Bound), singleton(Explicit, Explicit, [Override, lazyDependency(Override)])];
const { registerBazisGeneratedRuntime } = await import("./generated/bazis/runtime");
await registerBazisGeneratedRuntime();
const container = createContainer({ providers }, { validateOnBuild: true });
try {
  const a = container.resolve(A), b = container.resolve(B), override = container.resolve(Override);
  const inherited = container.resolve(Inherited), grandchild = container.resolve(Grandchild), generic = container.resolve(GenericChild);
  if (inherited.dependency !== a || inherited.lazy.value !== a || inherited.optional !== "default" || grandchild.dependency !== a || grandchild.lazy.value !== a) throw Error("inherited identity failed");
  if (generic.dependency !== b || generic.lazy.value !== b) throw Error("generic substitution failed");
  if (container.resolve(LocalChild).dependency !== a) throw Error("private base failed");
  if (container.resolve(DefaultChild).dependency !== a || container.resolve(DefaultChild).second !== b) throw Error("default parameter shifted dependencies");
  if (container.resolve(ContractChild).dependency !== container.resolve(IContract)) throw Error("named alias dependency failed");
  if (container.resolve(OwnConstructor).own !== a || container.resolve(OwnEmpty).dependency === a) throw Error("own constructor was overridden");
  if (container.resolve(Explicit).dependency !== override || container.resolve(Bound).dependency !== override) throw Error("explicit deps lost priority");
  console.log("inherited-constructor:PASS");
} finally { await container.dispose(); }
`,
  });
  try {
    await succeeds(root, "run", generator);
    const deps = await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text();
    expect(deps).toContain("import { Inherited as TargetClass_");
    expect(deps).toContain("import { default as TargetClass_");
    expect(deps).not.toContain("import { BaseService as TargetClass_");
    await succeeds(root, path.join(repo, "node_modules/typescript/bin/tsc"), "--noEmit");
    expect((await succeeds(root, "src/index.ts")).trim()).toBe("inherited-constructor:PASS");
    const binary = path.join(root, "app");
    await succeeds(root, "build", "--compile", "src/index.ts", "--outfile", binary);
    const child = Bun.spawn([binary], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(stdout.trim()).toBe("inherited-constructor:PASS");
  } finally { await cleanup(root); }
}, 120_000);

test("private helpers and explicitly bound private services need no generated imports", async () => {
  const root = await project({
    "src/unreachable-helper.ts": 'class Dependency {} class InternalHelper { constructor(readonly dependency: Dependency) {} } export function helper() { return new InternalHelper(new Dependency()); }',
    "src/index.ts": `import { verify } from "./services";
const { registerBazisGeneratedRuntime } = await import("./generated/bazis/runtime");
await registerBazisGeneratedRuntime();
await verify();`,
    "src/services.ts": `import { createContainer, DI, singleton, singletonValue, createToken } from "bazis/core/di";
export class Dependency {}
class InternalHelper { constructor(readonly dependency: Dependency) {} }
class TypeOnlyHelper { constructor(readonly dependency: Dependency) {} }
export type { TypeOnlyHelper };
class Mixed { constructor(readonly dependency: Dependency) {} }
export type { Mixed };
export { Mixed as ValueAlias };
export const unrelated = { tools: [InternalHelper], controllers: [InternalHelper], background: [InternalHelper] };
export const unrelatedProvider = { provide: Dependency, useClass: InternalHelper };
class Explicit { constructor(readonly dependency: Dependency) {} }
class Bound { constructor(readonly dependency: Dependency) {} }
class Static { static inject = [Dependency]; constructor(readonly dependency: Dependency) {} }
const VALUE = createToken<string>("Value");
class ValueBase { constructor(readonly value: string) {} }
class ExplicitValue extends ValueBase {}
class StaticValue extends ValueBase { static inject = [VALUE]; }
DI.bindDeps(Bound, Dependency);
export async function verify() {
const container = createContainer({ providers: [singleton(Dependency), singleton(Mixed), singleton(Explicit, Explicit, [Dependency]), singleton(Bound), singleton(Static), singletonValue(VALUE, "bound-value"), singleton(ExplicitValue, ExplicitValue, [VALUE]), singleton(StaticValue)] }, { validateOnBuild: true });
try {
  for (const type of [Explicit, Bound, Static, Mixed]) if (container.resolve(type).dependency !== container.resolve(Dependency)) throw Error("private explicit binding failed");
  if (!(new InternalHelper(new Dependency()).dependency instanceof Dependency)) throw Error("helper failed");
  if (container.resolve(ExplicitValue).value !== "bound-value" || container.resolve(StaticValue).value !== "bound-value") throw Error("explicit inherited value binding failed");
  console.log("private-classes:PASS");
} finally { await container.dispose(); }
}
`,
  });
  try {
    await succeeds(root, "run", generator);
    const deps = await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text();
    for (const name of ["InternalHelper", "TypeOnlyHelper", "Explicit", "Bound", "Static"]) expect(deps).not.toContain(name);
    expect(deps).toContain("import { ValueAlias as TargetClass_");
    await succeeds(root, path.join(repo, "node_modules/typescript/bin/tsc"), "--noEmit");
    expect((await succeeds(root, "src/index.ts")).trim()).toBe("private-classes:PASS");
  } finally { await cleanup(root); }
}, 60_000);

test.each([
  'class Base { constructor(readonly dependency: string) {} }',
  'class Base { constructor(readonly dependency: Dependency | null) {} }',
  'interface MissingToken { value: string }; class Base { constructor(readonly dependency: MissingToken) {} }',
])("unsupported inferred inherited constructors fail before publication: %s", async base => {
  const root = await project({
    "src/index.ts": `import { singleton } from "bazis/core/di";
export class Dependency {}
${base}
export class Child extends Base {}
export const registration = singleton(Child);
`,
  });
  try {
    const generated = await run(root, "run", generator);
    expect(generated.exit).not.toBe(0);
    expect(generated.stderr).toContain("BAZIS_DI_CONSTRUCTOR_UNRESOLVED");
    expect(await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).exists()).toBe(false);
  } finally { await cleanup(root); }
}, 60_000);

test.each([
  'export const registration = addScoped(InternalService);',
  'export const registration = DI.singleton(DI.classProvider(InternalService, InternalService));',
  'export const registration = DI.singleton({ provide: InternalService, useClass: InternalService });',
  '@Module({ background: [InternalService] }) export class RootModule {}',
  'const metadata = { background: [InternalService] }; export const container = createContainer(metadata);',
  'const provider = { provide: InternalService, useClass: InternalService }; export const services = new ServiceCollection().addSingleton(provider);',
  'export type { InternalService }; export const registration = addScoped(InternalService);',
])("private inferred DI classes fail before generated publication: %s", async registration => {
  const root = await project({
    "src/index.ts": `import { scoped as addScoped, DI, Module, createContainer, ServiceCollection } from "bazis/core/di";
export class Dependency {}
class InternalService { constructor(readonly dependency: Dependency) {} start() {} stop() {} }
${registration}
`,
    "src/generated/bazis/deps.ts": "export const previousOutput = true;\n",
  });
  try {
    const generated = await run(root, "run", generator);
    expect(generated.exit).not.toBe(0);
    expect(generated.stderr).toContain("BAZIS_DI_CLASS_UNIMPORTABLE");
    expect(generated.stderr).toContain('DI class "InternalService" must be exported');
    expect(await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text()).toBe("export const previousOutput = true;\n");
    expect(await Bun.file(path.join(root, "src/generated/bazis/runtime.ts")).exists()).toBe(false);
  } finally { await cleanup(root); }
}, 60_000);
