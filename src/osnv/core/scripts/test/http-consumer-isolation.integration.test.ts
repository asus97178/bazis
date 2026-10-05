import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A clean consumer must keep its real method name. The framework's own
// application also has UsersController.list with a different DTO signature.
test("clean UsersController.list starts through runApp in source and binary without foreign bindings", async () => {
  const repository = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "osnv-http-consumer-"));
  const source = `import { Module, singleton } from "osnv/core/di";
import { Controller, Get, Ok } from "osnv/core/http";
export class UsersService { async getAll() { return [{ id: 1, name: "Alice" }]; } }
@Controller("users") export class UsersController {
  constructor(private readonly users: UsersService) {}
  @Get() async list() { return Ok(await this.users.getAll()); }
}
@Module({ controllers: [UsersController], providers: [singleton(UsersService)] })
export class AppModule {}
`;
  async function command(args: string[]) {
    const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stdout + stderr).toBe(0);
  }
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.join(repository, "src/osnv"), path.join(root, "node_modules/osnv"));
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true,
    }, include: ["src/**/*.ts"] }));
    await Bun.write(path.join(root, "osnv.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
    await Bun.write(path.join(root, "src/Users.module.ts"), source);
    await Bun.write(path.join(root, "src/index.ts"), `import { runApp } from "osnv/core/app";
import { AppModule } from "./Users.module";
import { registerOsnvGeneratedRuntime } from "./generated/osnv/runtime";
await registerOsnvGeneratedRuntime();
process.exitCode = await runApp(AppModule, { http: { port: Number(process.env.PROBE_PORT), prefix: "api", docs: false } });
`);
    await command([path.join(repository, "src/osnv/core/scripts/di-generate.ts")]);
    const bindings = await Bun.file(path.join(root, "src/generated/osnv/bindings.ts")).text();
    expect(bindings).toContain('"list":[]');
    expect(bindings).not.toContain("UserListQuery");
    // The framework no longer has a package-level bindings file that app routes could leak into.
    expect(await Bun.file(path.join(repository, "src/osnv/core/http/generated/bindings.ts")).exists()).toBe(false);
    expect(await Bun.file(path.join(repository, "src/osnv/core/http/Binding/autoBindings.ts")).text()).not.toContain('"../generated/bindings"');
    const binary = path.join(root, "consumer-bin");
    await command(["build", "--compile", "src/index.ts", "--outfile", binary]);
    for (const args of [[process.execPath, "run", "src/index.ts"], [binary]]) {
      const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = reservation.port!;
      await reservation.stop(true);
      const child = Bun.spawn(args, { cwd: root, env: { ...process.env, PROBE_PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      try {
        let response: Response | undefined;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && child.exitCode === null) {
          try { response = await fetch(`http://localhost:${port}/api/users`); break; }
          catch { await Bun.sleep(25); }
        }
        expect(response?.status).toBe(200);
        expect(await response!.json()).toEqual([{ id: 1, name: "Alice" }]);
      } finally {
        child.kill("SIGTERM");
        const exit = await child.exited;
        const [stdout, stderr] = await output;
        expect(exit, stdout + stderr).toBe(0);
        expect(stdout + stderr).not.toContain("UserListQuery");
      }
    }
  } finally {
    // Unlink the dependency explicitly before recursive cleanup.
    await rm(path.join(root, "node_modules/osnv"), { force: true });
    // Compiling from the qualified immutable Bun executable preserves its
    // macOS flag on Bun's private build copy. Remove only this test's copies.
    if (process.platform === "darwin") {
      for (const name of await readdir(root)) {
        if (!/^\.[a-f0-9]+-[a-f0-9]+\.bun-build$/.test(name)) continue;
        const cleanup = Bun.spawn(["/usr/bin/chflags", "nouchg", path.join(root, name)], { stdout: "ignore", stderr: "pipe" });
        const [exit, stderr] = await Promise.all([cleanup.exited, new Response(cleanup.stderr).text()]);
        expect(exit, stderr).toBe(0);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
