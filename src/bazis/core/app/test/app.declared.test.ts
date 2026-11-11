import { afterEach, expect, test } from "bun:test";
import { App, runApp } from "@/core/app";
import { appOptionsOf } from "@/core/app/runApp";
import { Module, singleton } from "@/core/di";
import { Controller, Get, HttpServer, httpConfig } from "@/core/http";
import { HOSTED_SERVICE } from "@/core/di";
import { ConfigView, defineConfig } from "@/core/kernel";
import { createTestContainer, startTestApp } from "@/core/testing";

// 0.138.0: the application is declared once with @App; runApp and the tests read the same declaration.
class Greeter {
  hello(name: string): string { return `Hello, ${name}`; }
}

@Controller("hello")
class HelloController {
  @Get() hello() { return { text: "hello" }; }
}

@Module({ controllers: [HelloController], providers: [singleton(Greeter)], exports: [Greeter] })
class HelloModule {}

const noteConfig = defineConfig("note", { default: { text: "from the app" } });

@App({ modules: [HelloModule], config: noteConfig, http: { prefix: "api", health: true } })
class HelloApp {}

@App({ modules: [HelloModule] })
class WorkerApp {}

afterEach(() => {
  delete process.env.BAZIS_HTTP__PORT;
  delete process.env.BAZIS_HTTP__HOST;
});

test("@App keeps what it declares and makes the class the root module", () => {
  expect(appOptionsOf(HelloApp)).toMatchObject({ modules: [HelloModule], http: { prefix: "api", health: true } });
  expect((HelloApp as unknown as { imports: unknown[] }).imports).toEqual([HelloModule]);
  expect(appOptionsOf(HelloModule)).toBeUndefined();
});

test("a test starts the declared application: its prefix, its health check, its config", async () => {
  const app = await startTestApp(HelloApp);
  try {
    expect(await (await app.fetch("/api/hello")).json()).toEqual({ text: "hello" });
    expect((await app.fetch("/health")).status).toBe(200);
    expect((app.container.resolve(noteConfig.token) as ConfigView<typeof noteConfig>).get("text")).toBe("from the app");
  } finally {
    await app.stop();
  }
});

test("test options replace single fields of the declaration", async () => {
  const app = await startTestApp(HelloApp, { http: { prefix: "v2" } });
  try {
    expect((await app.fetch("/v2/hello")).status).toBe(200);
    expect((await app.fetch("/api/hello")).status).toBe(404);
    // The rest of the declared http options stays.
    expect((await app.fetch("/health")).status).toBe(200);
  } finally {
    await app.stop();
  }
});

test("an application without http starts no server in a test; http: false removes a declared one", async () => {
  for (const app of [await startTestApp(WorkerApp), await startTestApp(HelloApp, { http: false })]) {
    try {
      expect(app.url).toBe("");
      expect(app.container.resolveAll(HOSTED_SERVICE).some((service) => service instanceof HttpServer)).toBe(false);
    } finally {
      await app.stop();
    }
  }
});

test("app.use calls a service in a scope of its own", async () => {
  const app = await startTestApp(WorkerApp);
  try {
    expect(await app.use(Greeter, (greeter) => greeter.hello("Ann"))).toBe("Hello, Ann");
  } finally {
    await app.stop();
  }
});

test("createTestContainer of an @App holds its configs", async () => {
  const container = await createTestContainer(HelloApp);
  expect((container.resolve(noteConfig.token) as ConfigView<typeof noteConfig>).get("text")).toBe("from the app");
  await container.dispose();
});

test("runApp takes only a class marked @App: a module is a configuration error", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  const before = process.exitCode;
  try {
    expect(await runApp(HelloModule)).toBe(1);
  } finally {
    console.error = original;
    process.exitCode = before ?? 0;
  }
  expect(lines.join("\n")).toContain("HelloModule is not an application: mark the class with @App({ modules: [...] }).");
});

test("@App without modules is refused where it is written", () => {
  expect(() => {
    @App({} as never)
    class Broken {}
    return Broken;
  }).toThrow("@App on Broken: modules must be an array of the application's modules.");
});

test("the address comes from the http settings unless the code fixes it", async () => {
  expect(httpConfig.resolve("development").get("host")).toBe("127.0.0.1");
  expect(httpConfig.resolve("development").get("port")).toBe(3000);
  expect(httpConfig.resolve("production").get("host")).toBe("0.0.0.0");

  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const free = probe.port;
  await probe.stop(true);
  process.env.BAZIS_HTTP__PORT = String(free);

  // A test fixes port 0 in code: the setting does not move it.
  const fixed = await startTestApp(HelloApp);
  try {
    expect(fixed.url).not.toBe(`http://127.0.0.1:${free}`);
  } finally {
    await fixed.stop();
  }

  // Without a port in code the server listens where the setting says.
  const { Bazis } = await import("@/core/kernel");
  const { composeApp } = await import("@/core/app/runApp");
  const kernel = await Bazis.createBuilder(composeApp(HelloApp, { http: {} })).useOptions({ startupReport: false, environment: "test", signals: [] }).build();
  await kernel.start();
  try {
    expect((await fetch(`http://127.0.0.1:${free}/hello`)).status).toBe(200);
  } finally {
    await kernel.stop();
  }
});

test("a wrong port in the environment stops the start", async () => {
  process.env.BAZIS_HTTP__PORT = "70000";
  await expect(startTestApp(HelloApp)).rejects.toThrow("http.port");
});
