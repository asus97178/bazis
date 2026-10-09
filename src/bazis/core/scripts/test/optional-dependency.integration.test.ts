import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Optional constructor parameters: injected when registered, unset otherwise.
// Before, codegen skipped them while the container counted them through
// Function.length, so `cache?: ICache` failed validation with a misleading
// "run bazis codegen" hint.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

test("optional constructor dependencies resolve when registered and stay unset otherwise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-optional-dependency-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), `import { Module, scoped, singleton } from "bazis/core/di";

export abstract class IMailer { abstract send(to: string): string; }
export class ConsoleMailer extends IMailer { send(to: string) { return "sent to " + to; } }
export class Clock { now() { return "registered clock"; } }
export class FixedClock extends Clock { override now() { return "default clock"; } }
export interface Options { readonly retries?: number }

export class Notifier {
  constructor(
    private readonly clock: Clock,
    private readonly mailer?: IMailer,
    private readonly options: Options = { retries: 3 },
  ) {}
  describe() { return { clock: this.clock.now(), mailer: this.mailer?.send("ann") ?? null, retries: this.options.retries }; }
}

export class Reporter {
  constructor(private readonly clock: Clock = new FixedClock()) {}
  describe() { return this.clock.now(); }
}

export class InheritedNotifier extends Notifier {}

@Module({ providers: [singleton(Clock), scoped(IMailer, ConsoleMailer), scoped(Notifier), scoped(Reporter), scoped(InheritedNotifier)], exports: [] })
export class WithMailer {}

@Module({ providers: [scoped(Reporter)], exports: [] })
export class Bare {}

@Module({ providers: [singleton(Clock), scoped(Notifier), scoped(InheritedNotifier)], exports: [] })
export class WithoutMailer {}
`);
  await Bun.write(path.join(root, "probe.ts"), `import { createTestContainer } from "bazis/core/testing";
import { Bare, InheritedNotifier, Notifier, Reporter, WithMailer, WithoutMailer } from "./src/index";
const describe = async (root: any, token: any) => (await createTestContainer(root)).createScope().resolve(token).describe();
console.log(JSON.stringify({
  withMailer: await describe(WithMailer, Notifier),
  withoutMailer: await describe(WithoutMailer, Notifier),
  inherited: await describe(WithoutMailer, InheritedNotifier),
  reporterRegistered: await describe(WithMailer, Reporter),
  reporterDefault: await describe(Bare, Reporter),
}));
`);
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);
  const deps = await Bun.file(path.join(root, "src/generated/bazis/deps.ts")).text().catch(() => "");
  expect(deps).toContain("optionalDependency(");

  const probe = await run(root, ["probe.ts"]);
  expect(probe.exit, probe.output).toBe(0);
  expect(JSON.parse(probe.last)).toEqual({
    withMailer: { clock: "registered clock", mailer: "sent to ann", retries: 3 },
    withoutMailer: { clock: "registered clock", mailer: null, retries: 3 },
    inherited: { clock: "registered clock", mailer: null, retries: 3 },
    reporterRegistered: "registered clock",
    reporterDefault: "default clock",
  });
}, 60_000);
