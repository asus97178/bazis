import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A contract declared as an abstract class needs no createToken: codegen wires
// a constructor parameter typed with it like any class dependency.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-abstract-token-"));
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

test("a constructor parameter typed with an abstract class gets its registered implementation", async () => {
  const root = await project({
    "src/clock/IClock.service.ts": `export abstract class IClock {
  abstract now(): string;
}
`,
    "src/clock/Clock.service.ts": `import type { IClock } from "./IClock.service";
export class FixedClock implements IClock { now() { return "2026-01-01"; } }
`,
    "src/clock/Clock.module.ts": `import { Module, singleton } from "bazis/core/di";
import { FixedClock } from "./Clock.service";
import { IClock } from "./IClock.service";
@Module({ providers: [singleton(IClock, FixedClock)], exports: [IClock] })
export class ClockModule {}
`,
    "src/index.ts": `import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import type { IClock } from "./clock/IClock.service";
import { ClockModule } from "./clock/Clock.module";
export class Report { constructor(private readonly clock: IClock) {} text() { return "at " + this.clock.now(); } }
@Controller("report") export class ReportController {
  constructor(private readonly report: Report, private readonly clock: IClock) {}
  @Get() get() { return { report: this.report.text(), now: this.clock.now() }; }
}
@Module({ imports: [ClockModule], providers: [scoped(Report)], controllers: [ReportController], exports: [] })
export class AppModule {}
`,
    "server.ts": `import { runApp } from "bazis/core/app";
import { AppModule } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
const port = 20000 + Math.floor(Math.random() * 20000);
void runApp(AppModule, { http: { hostname: "127.0.0.1", port } });
const url = "http://127.0.0.1:" + port + "/report";
for (let i = 0; i < 100 && !(await fetch(url).then(() => true, () => false)); i++) await Bun.sleep(50);
console.log(JSON.stringify(await fetch(url).then((r) => r.json())));
process.exit(0);
`,
  });
  const generated = await run(root, [codegen]);
  expect(generated.exit, generated.output).toBe(0);

  const served = await run(root, ["server.ts"]);
  expect(JSON.parse(served.last), served.output).toEqual({ report: "at 2026-01-01", now: "2026-01-01" });
}, 60_000);
