import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer, type DiContainer } from "@/core/di";
import {
  Controller,
  Get,
  HttpServer,
  Middleware,
  Post,
  cors,
  createCorrelationIdMiddleware,
  httpModule,
  type AccessLogEntry,
  type HttpModuleOptions,
} from "../index";

// A route's own cors() answers preflights (before: 405), a global
// correlation middleware covers responses produced before routing (before:
// no x-request-id on 404/405/413/preflight), and access log durations are
// rounded to 0.01 ms.

@Controller("public")
@Middleware(cors({ origin: "*" }))
class PublicController {
  @Get() get() { return { public: true }; }
  @Post() post() { return { posted: true }; }
  @Post("strict") @Middleware(cors({ origin: "https://app.example.com", maxAgeSeconds: 60 })) strict() { return {}; }
}

@Controller("private")
class PrivateController {
  @Post() post() { return { posted: true }; }
}

@Module({ controllers: [PublicController, PrivateController] })
class ControllersModule {}

async function start(options: Omit<HttpModuleOptions, "imports" | "controllers" | "port">) {
  @Module({ imports: [httpModule({ ...options, imports: [ControllersModule], port: 0 })] })
  class App {}
  const container: DiContainer = createContainer(App);
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  return { base, stop: async () => { await server.stop(); await container.dispose(); } };
}

const preflight = (origin: string, method = "POST") => ({
  method: "OPTIONS",
  headers: { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" },
});

describe("per-route CORS answers preflights", () => {
  let app: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => { app = await start({}); });
  afterAll(async () => { await app.stop(); });

  test("a controller's cors() answers the preflight of its routes", async () => {
    const response = await fetch(`${app.base}/public`, preflight("https://any.org"));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  test("a method's cors() wins over the controller's", async () => {
    const allowed = await fetch(`${app.base}/public/strict`, preflight("https://app.example.com"));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(allowed.headers.get("access-control-max-age")).toBe("60");
    const denied = await fetch(`${app.base}/public/strict`, preflight("https://evil.org"));
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("routes without cors() and unknown paths are not answered", async () => {
    expect((await fetch(`${app.base}/private`, preflight("https://any.org"))).status).toBe(405);
    expect((await fetch(`${app.base}/nowhere`, preflight("https://any.org"))).status).toBe(404);
    // The requested method decides the route: there is no DELETE /public.
    expect((await fetch(`${app.base}/public`, preflight("https://any.org", "DELETE"))).status).toBe(405);
  });
});

describe("global middleware", () => {
  const entries: AccessLogEntry[] = [];
  let app: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    app = await start({
      accessLog: { log: (entry) => entries.push(entry) },
      maxBodyBytes: 16,
      middleware: [createCorrelationIdMiddleware(), cors({ origin: "https://app.example.com" })],
    });
  });
  afterAll(async () => { await app.stop(); });

  test("a cors() among the global middleware answers every preflight", async () => {
    const response = await fetch(`${app.base}/private`, preflight("https://app.example.com"));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
  });

  test("responses produced before routing carry the correlation id", async () => {
    const headers = { "x-request-id": "req-404" };
    expect((await fetch(`${app.base}/nowhere`, { headers })).headers.get("x-request-id")).toBe("req-404");
    expect((await fetch(`${app.base}/public`, { method: "PUT", headers: { "x-request-id": "req-405" } })).headers.get("x-request-id")).toBe("req-405");
    const tooLarge = await fetch(`${app.base}/private`, { method: "POST", headers: { "x-request-id": "req-413" }, body: "x".repeat(64) });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get("x-request-id")).toBe("req-413");
    const generated = await fetch(`${app.base}/nowhere`);
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(entries.find((entry) => entry.status === 404 && entry.requestId === "req-404")).toBeDefined();
    expect(entries.find((entry) => entry.status === 413)?.requestId).toBe("req-413");
  });

  test("access log durations are rounded to 0.01 ms", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(Math.round(entry.durationMs * 100) / 100).toBe(entry.durationMs);
  });
});
