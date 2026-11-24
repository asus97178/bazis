import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// An entry point is `await runApp(App)` alone: the generated code is connected
// by runApp when the application starts from sources, and compiled in through
// the generated `executable.ts` when it is built into a binary.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    // The compile scratch copy inherits the launcher's immutable flag on macOS.
    if (process.platform === "darwin") await Bun.spawn(["/usr/bin/chflags", "-R", "nouchg", root], { stdout: "ignore", stderr: "ignore" }).exited;
    await rm(root, { recursive: true, force: true });
  }
});

const codegen = path.join(repository, "src/bazis/core/scripts/di-generate.ts");

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-run-app-generated-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  const files: Record<string, string> = {
    "bazis.config.json": JSON.stringify({ version: 1, defaultTarget: "production", targets: {
      production: { entrypoints: ["src/index.ts"] },
      worker: { entrypoints: ["src/worker.ts"] },
    } }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }),
    "src/shared/Name.service.ts": `export class NameService { get() { return "Ann"; } }
`,
    // The site: what the default entry point serves.
    "src/site/Site.module.ts": `import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { NameService } from "../shared/Name.service";
export class Greeter { constructor(private readonly name: NameService) {} text() { return "hi, " + this.name.get(); } }
@Controller("hello") export class HelloController {
  constructor(private readonly greeter: Greeter) {}
  @Get() get() { return { hello: this.greeter.text() }; }
}
@Module({ providers: [scoped(NameService), scoped(Greeter)], controllers: [HelloController], exports: [] })
export class SiteModule {}
`,
    "src/site/Site.app.ts": `import { App } from "bazis/core/app";
import { SiteModule } from "./Site.module";
@App({ modules: [SiteModule], http: {} })
export class SiteApp {}
`,
    "src/index.ts": `import { runApp } from "bazis/core/app";
import { SiteApp } from "./site/Site.app";

await runApp(SiteApp);
`,
    // The worker: a second entry point with classes the site never imports.
    "src/jobs/Jobs.module.ts": `import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { NameService } from "../shared/Name.service";
export class Job { constructor(private readonly name: NameService) {} text() { return "job of " + this.name.get(); } }
@Controller("job") export class JobController {
  constructor(private readonly job: Job) {}
  @Get() get() { return { job: this.job.text() }; }
}
@Module({ providers: [scoped(NameService), scoped(Job)], controllers: [JobController], exports: [] })
export class JobsModule {}
`,
    "src/jobs/Jobs.app.ts": `import { App } from "bazis/core/app";
import { JobsModule } from "./Jobs.module";
@App({ modules: [JobsModule], http: {} })
export class JobsApp {}
`,
    "src/worker.ts": `import { runApp } from "bazis/core/app";
import { JobsApp } from "./jobs/Jobs.app";

await runApp(JobsApp);
`,
  };
  for (const [name, content] of Object.entries(files)) await Bun.write(path.join(root, name), content);
  return root;
}

async function run(cwd: string, command: string[]): Promise<{ exit: number; output: string }> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err };
}

/** A port the OS has just handed out. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** Starts an application, asks it one route and stops it. */
async function ask(cwd: string, command: string[], route: string): Promise<{ answer: unknown; output: string }> {
  const port = freePort();
  const child = Bun.spawn(command, { cwd, env: { ...process.env, BAZIS_HTTP__PORT: String(port), BAZIS_UI: "0" }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([out, err]) => out + err);
  let answer: unknown;
  try {
    // A loaded CI runner can take several seconds to start the app: wait up to 20.
    for (let attempt = 0; attempt < 400 && answer === undefined && child.exitCode === null; attempt += 1) {
      answer = await fetch(`http://127.0.0.1:${port}${route}`).then((response) => response.ok ? response.json() : undefined, () => undefined);
      if (answer === undefined) await Bun.sleep(50);
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
  return { answer, output: await output };
}

test("an entry point that only calls runApp gets its generated code, from sources and in a binary", async () => {
  const root = await project();
  const outside = await mkdtemp(path.join(tmpdir(), "bazis-run-app-outside-"));
  roots.push(outside);
  const generated = await run(root, [process.execPath, codegen, "--target", "all"]);
  expect(generated.exit, generated.output).toBe(0);

  // From sources runApp finds the generated code of the entry point Bun was started with.
  const site = await ask(root, [process.execPath, "src/index.ts"], "/hello");
  expect(site.answer, site.output).toEqual({ hello: "hi, Ann" });
  // The worker's classes exist only in its own target: the default one would not wire them.
  const worker = await ask(root, [process.execPath, "src/worker.ts"], "/job");
  expect(worker.answer, worker.output).toEqual({ job: "job of Ann" });

  // A binary is compiled from the generated executable.ts of its target.
  for (const [entry, binary, route, expected] of [
    ["src/generated/bazis/executable.ts", "site-bin", "/hello", { hello: "hi, Ann" }],
    ["src/generated/bazis/targets/worker/executable.ts", "worker-bin", "/job", { job: "job of Ann" }],
  ] as const) {
    const compiled = await run(root, [process.execPath, "build", "--compile", entry, "--outfile", path.join(outside, binary)]);
    expect(compiled.exit, compiled.output).toBe(0);
    // Started outside the project: nothing but the binary itself.
    const served = await ask(outside, [path.join(outside, binary)], route);
    expect(served.answer, served.output).toEqual(expected);
  }
}, 180_000);

test("a binary compiled from the entry point itself says how to build it", async () => {
  const root = await project();
  const outside = await mkdtemp(path.join(tmpdir(), "bazis-run-app-outside-"));
  roots.push(outside);
  expect((await run(root, [process.execPath, codegen, "--target", "all"])).exit).toBe(0);
  const compiled = await run(root, [process.execPath, "build", "--compile", "src/index.ts", "--outfile", path.join(outside, "bare-bin")]);
  expect(compiled.exit, compiled.output).toBe(0);

  const started = await run(outside, [path.join(outside, "bare-bin")]);
  expect(started.exit).toBe(1);
  expect(started.output).toContain("was compiled without the code `bazis codegen` generates");
  expect(started.output).toContain("bazis build --bin");
  expect(started.output).toContain("src/generated/bazis/executable.ts");
}, 120_000);
