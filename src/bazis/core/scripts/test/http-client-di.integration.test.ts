import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A service takes HttpClient and HttpClientFactory by type (before: "Missing
// dependency HttpClient" / BAZIS_DI_DEPENDENCY_UNKNOWN), and an unhandled
// upstream failure answers 504/502 instead of 500.
const repository = process.cwd();
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function run(root: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, output: out + err, last: out.trim().split("\n").at(-1) ?? "" };
}

test("HttpClient and HttpClientFactory inject by type; upstream failures answer 502/504", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bazis-http-client-di-"));
  roots.push(root);
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.join(repository, "src/bazis"), path.join(root, "node_modules/bazis"));
  await Bun.write(path.join(root, "bazis.config.json"), JSON.stringify({ version: 1, defaultTarget: "production", targets: { production: { entrypoints: ["src/index.ts"] } } }));
  await Bun.write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, types: ["bun"] }, include: ["src/**/*.ts"] }));
  await Bun.write(path.join(root, "src/index.ts"), `import { Module, scoped } from "bazis/core/di";
import { Controller, Get } from "bazis/core/http";
import { HttpClient, HttpClientFactory, httpClientModule } from "bazis/core/http-client";

export class WeatherService {
  constructor(private readonly http: HttpClient, private readonly clients: HttpClientFactory) {}
  async ok() { return (await this.http.get("/ok")).data; }
  async named() { return (await this.clients.createClient("slow").get("/slow")).data; }
  async missing() { return (await this.http.get("/missing")).data; }
}

@Controller("weather")
export class WeatherController {
  constructor(private readonly weather: WeatherService) {}
  @Get("ok") ok() { return this.weather.ok(); }
  @Get("slow") slow() { return this.weather.named(); }
  @Get("missing") missing() { return this.weather.missing(); }
}

export function appModule(baseUrl: string) {
  @Module({
    imports: [httpClientModule({ default: { baseUrl }, clients: { slow: { timeoutMs: 100 } } })],
    providers: [scoped(WeatherService)],
    controllers: [WeatherController],
    exports: [],
  })
  class AppModule {}
  return AppModule;
}
`);
  await Bun.write(path.join(root, "probe.ts"), `import { startTestApp } from "bazis/core/testing";
import { appModule } from "./src/index";
const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const { pathname } = new URL(req.url);
  if (pathname === "/ok") return Response.json({ ok: true });
  if (pathname === "/slow") { await Bun.sleep(1000); return Response.json({ slow: true }); }
  return Response.json({ error: "secret upstream detail" }, { status: 404 });
} });
const app = await startTestApp(appModule("http://127.0.0.1:" + upstream.port), { kernel: { environment: "production" } });
const get = async (path: string) => { const r = await app.fetch(path); return [r.status, await r.json()]; };
console.log(JSON.stringify({ ok: await get("/weather/ok"), slow: await get("/weather/slow"), missing: await get("/weather/missing") }));
await app.stop();
upstream.stop(true);
`);
  const generated = await run(root, [path.join(repository, "src/bazis/core/scripts/di-generate.ts")]);
  expect(generated.exit, generated.output).toBe(0);
  const probe = await run(root, ["probe.ts"]);
  expect(probe.exit, probe.output).toBe(0);
  expect(JSON.parse(probe.last)).toEqual({
    ok: [200, { ok: true }],
    slow: [504, { error: "Gateway Timeout" }],
    missing: [502, { error: "Bad Gateway" }],
  });
}, 60_000);
