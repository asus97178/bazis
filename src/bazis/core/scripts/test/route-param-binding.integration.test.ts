import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Route parameters come from the @Controller prefix and from wildcard segments
// too, not only from `:name` in the method template. Before the fix codegen
// bound them as required query parameters, so the request failed with 400.
test("codegen binds controller-prefix and wildcard route parameters", async () => {
  const repository = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), "bazis-route-params-"));
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, out + err).toBe(0);
    return out.trim();
  };
  try {
    await mkdir(path.join(root, "node_modules"));
    await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
    await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
    await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"],
    }, include: ["src/**/*.ts"] }));
    await Bun.write(path.join(root, "src/index.ts"), `import { Controller, Get } from "bazis/core/http";
@Controller("orgs/:org/things") export class ThingsController {
  @Get(":id(int)") byId(org: string, id: number) { return { org, id }; }
  @Get("files/*path") file(org: string, path: string) { return { org, path }; }
  @Get("raw/*") raw(org: string, rest: string, limit = 10) { return { org, rest, limit }; }
}
`);
    await run([path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
    const bindings = await Bun.file(path.join(root, "src/generated/bazis/bindings.ts")).text();
    for (const name of ["org", "id", "path", "rest"]) expect(bindings).toContain(`"source":"route","name":"${name}"`);
    expect(bindings).toContain(`"source":"query","name":"limit"`);

    // Serve the controller and call it over HTTP with the generated descriptors.
    await Bun.write(path.join(root, "server.ts"), `
import { Module } from "bazis/core/di";
import { runApp } from "bazis/core/app";
import { ThingsController } from "./src/index";
import { registerBazisGeneratedRuntime } from "./src/generated/bazis/runtime";
await registerBazisGeneratedRuntime();
@Module({ controllers: [ThingsController], exports: [] }) class Root {}
const port = 20000 + Math.floor(Math.random() * 20000);
void runApp(Root, { http: { hostname: "127.0.0.1", port } });
const base = "http://127.0.0.1:" + port;
for (let i = 0; i < 100 && !(await fetch(base + "/orgs/acme/things/1").then(() => true, () => false)); i++) await Bun.sleep(50);
const get = (url: string) => fetch(base + url).then(async (r) => [r.status, await r.json()]);
console.log(JSON.stringify([await get("/orgs/acme/things/7"), await get("/orgs/acme/things/files/a/b.txt"), await get("/orgs/acme/things/raw/x/y?limit=3")]));
process.exit(0);
`);
    expect(JSON.parse((await run(["server.ts"])).split("\n").at(-1)!)).toEqual([
      [200, { org: "acme", id: 7 }],
      [200, { org: "acme", path: "a/b.txt" }],
      [200, { org: "acme", rest: "x/y", limit: 3 }],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
