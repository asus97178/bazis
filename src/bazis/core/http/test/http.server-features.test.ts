import { registerGeneratedBindings } from "../Binding/autoBindings";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DI, HOSTED_SERVICE, Module, createContainer, type DiContainer } from "@/core/di";
import { HEALTH_CHECK, HealthService, type HealthCheck } from "@/core/kernel";
import {
  Controller,
  Created,
  Get,
  HttpServer,
  Post,
  httpModule,
  type HttpContext,
  type AccessLogEntry,
  type HttpModuleOptions,
} from "@/core/http";

let headStreamCanceled = false;

@Controller("things")
class ThingsController {
  @Get(":id(int)")
  get(id: number): { id: number } {
    return { id };
  }

  @Post()
  async create(ctx: HttpContext) {
    const body = await ctx.json();
    return Created(undefined, body);
  }

  @Get("stream")
  stream(): Response {
    headStreamCanceled = false;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream body"));
      },
      cancel() {
        headStreamCanceled = true;
      },
    }), { headers: { "content-type": "text/plain" } });
  }
}
// Unit fixture for the generated registry; real inference is covered by codegen-dx.integration.test.ts.
registerGeneratedBindings(ThingsController, {
  get: [{source: "route", name: "id", type: "number", optional: false}],
}, new Map([]));

@Module({ controllers: [ThingsController] })
class ThingsModule {}

function streamBody(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface StartedServer {
  readonly server: HttpServer;
  readonly base: string;
  dispose(): Promise<void>;
}

async function startServer(
  options: Omit<HttpModuleOptions, "imports" | "port">,
  extraProviders: readonly import("@/core/di").ProviderDefinition[] = [],
): Promise<StartedServer> {
  @Module({
    imports: [httpModule({ ...options, imports: [ThingsModule], port: 0 })],
    providers: [...extraProviders],
  })
  class App {}

  const container: DiContainer = createContainer(App, { validateOnBuild: true });
  const server = container.resolveAll(HOSTED_SERVICE)[0] as HttpServer;
  await server.start();
  return {
    server,
    base: `http://localhost:${server.port}`,
    dispose: async () => {
      await server.stop();
      await container.dispose();
    },
  };
}

test("HTTP: port 0 delegates collision-free ephemeral allocation to the OS", async () => {
  const [first, second] = await Promise.all([startServer({}), startServer({})]);
  try {
    expect(first.server.port).toBeGreaterThan(0);
    expect(second.server.port).toBeGreaterThan(0);
    expect(first.server.port).not.toBe(second.server.port);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});

describe("HTTP: request body limit", () => {
  let app: StartedServer;
  beforeAll(async () => {
    app = await startServer({ maxBodyBytes: 32 });
  });
  afterAll(() => app.dispose());

  test("Content-Length above the limit -> 413", async () => {
    const big = JSON.stringify({ payload: "x".repeat(100) });
    const response = await fetch(`${app.base}/things`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: big,
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toBe("Payload Too Large");
  });

  test("a streaming body without Content-Length is limited too -> 413", async () => {
    const big = JSON.stringify({ payload: "x".repeat(100) });
    const response = await fetch(`${app.base}/things`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: streamBody(big),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toBe("Payload Too Large");
  });

  test("a body within the limit passes", async () => {
    const response = await fetch(`${app.base}/things`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: 1 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: 1 });
  });
});

describe("HTTP: CORS config safety", () => {
  test("credentials require an explicit origin allow list or predicate", async () => {
    await expect(startServer({ cors: { credentials: true } })).rejects.toThrow("CORS credentials require");
    await expect(startServer({ cors: { origin: "*", credentials: true } })).rejects.toThrow("CORS credentials require");
    await expect(startServer({ cors: { origin: ["*"], credentials: true } })).rejects.toThrow("CORS credentials require");
  });

  test("throwing origin predicate fails closed without replacing the route response", async () => {
    const app = await startServer({ cors: { origin: () => { throw new Error("cors secret"); } } });
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(`${app.base}/things/3`, { headers: { origin: "https://app.example" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.json()).toEqual({ id: 3 });
    } finally {
      console.error = originalError;
      await app.dispose();
    }
  });
});

describe("HTTP: automatic HEAD", () => {
  let app: StartedServer;
  beforeAll(async () => {
    app = await startServer({});
  });
  afterAll(() => app.dispose());

  test("HEAD on a GET route: status and headers without a body", async () => {
    const response = await fetch(`${app.base}/things/7`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe("");
  });

  test("HEAD on a route without GET -> 405", async () => {
    // /things supports only POST.
    const response = await fetch(`${app.base}/things`, { method: "HEAD" });
    expect(response.status).toBe(405);
  });

  test("HEAD cancels the streaming body of the GET fallback", async () => {
    const response = await fetch(`${app.base}/things/stream`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(headStreamCanceled).toBe(true);
  });
});

describe("HTTP: access log", () => {
  test("logs method, path, status and duration", async () => {
    const entries: AccessLogEntry[] = [];
    const app = await startServer({ accessLog: { log: (entry) => entries.push(entry) } });
    try {
      await fetch(`${app.base}/things/3`);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ method: "GET", path: "/things/3", status: 200 });
      expect(entries[0]!.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await app.dispose();
    }
  });

  test("logs a framework 404, and a sink error does not break the response", async () => {
    const entries: AccessLogEntry[] = [];
    const app = await startServer({
      accessLog: {
        log: (entry) => {
          entries.push(entry);
          if (entry.path === "/things/3") {
            throw new Error("sink secret");
          }
        },
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const missing = await fetch(`${app.base}/missing`);
      expect(missing.status).toBe(404);
      const ok = await fetch(`${app.base}/things/3`);
      expect(ok.status).toBe(200);
      expect(entries.map((entry) => entry.path)).toEqual(["/missing", "/things/3"]);
    } finally {
      console.error = originalError;
      await app.dispose();
    }
  });
});

describe("HTTP: health endpoint", () => {
  test("without HealthService -> 200 healthy", async () => {
    const app = await startServer({ health: true });
    try {
      const response = await fetch(`${app.base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ healthy: true, checks: [] });
    } finally {
      await app.dispose();
    }
  });

  test("a failing check -> 503 with a report", async () => {
    const providers = [
      DI.singleton(
        DI.valueProvider(HEALTH_CHECK, {
          name: "db",
          check: () => {
            throw new Error("down");
          },
        } satisfies HealthCheck),
      ),
      DI.singleton(DI.factoryProviderWithResolver(HealthService, [], (resolver) => new HealthService(resolver))),
    ];
    const app = await startServer({ health: { path: "/healthz" } }, providers);
    try {
      const response = await fetch(`${app.base}/healthz`);
      expect(response.status).toBe(503);
      const report = (await response.json()) as {
        healthy: boolean;
        checks: { name: string; healthy: boolean }[];
      };
      expect(report.healthy).toBe(false);
      expect(report.checks[0]).toMatchObject({ name: "db", healthy: false });
      expect(JSON.stringify(report)).not.toContain("down");
    } finally {
      await app.dispose();
    }
  });

  test("details are available only with an explicit opt-in", async () => {
    const providers = [
      DI.singleton(
        DI.valueProvider(HEALTH_CHECK, {
          name: "db",
          check: () => {
            throw new Error("postgres://admin:secret@db.internal/app");
          },
        } satisfies HealthCheck),
      ),
      DI.singleton(DI.factoryProviderWithResolver(HealthService, [], (resolver) => new HealthService(resolver))),
    ];
    const app = await startServer({ health: { exposeDetails: true } }, providers);
    try {
      const response = await fetch(`${app.base}/health`);
      expect(await response.text()).toContain("postgres://admin:secret@db.internal/app");
    } finally {
      await app.dispose();
    }
  });

  test("concurrent probes share one check and timeout is bounded", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const providers = [
      DI.singleton(
        DI.valueProvider(HEALTH_CHECK, {
          name: "slow",
          check: async () => {
            calls += 1;
            await gate;
            return { healthy: true };
          },
        } satisfies HealthCheck),
      ),
      DI.singleton(DI.factoryProviderWithResolver(HealthService, [], (resolver) => new HealthService(resolver))),
    ];
    const app = await startServer({ health: { timeoutMs: 20 } }, providers);
    try {
      const first = fetch(`${app.base}/health`);
      const second = fetch(`${app.base}/health`);
      const responses = await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect(responses.map((response) => response.status)).toEqual([503, 503]);
      expect(await responses[0]!.text()).not.toContain("timed out");

      const repeatedStartedAt = performance.now();
      const repeated = await fetch(`${app.base}/health`);
      expect(repeated.status).toBe(503);
      expect(performance.now() - repeatedStartedAt).toBeLessThan(250);
      expect(calls).toBe(1);

      release();
      await Bun.sleep(0);
      const recovered = await fetch(`${app.base}/health`);
      expect(recovered.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      release();
      await app.dispose();
    }
  });
});

describe("HTTP: request scope disposal", () => {
  test("a hanging disposer cannot retain an already-produced response forever", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class HangingScopedResource {
      dispose(): Promise<void> {
        return gate;
      }
    }
    const providers = [
      DI.scoped(DI.classProvider(HangingScopedResource, HangingScopedResource, [])),
    ];
    const app = await startServer({
      requestScopeDisposeTimeoutMs: 15,
      middleware: [async (ctx, next) => {
        ctx.services.resolve(HangingScopedResource);
        await next();
      }],
    }, providers);
    const originalError = console.error;
    console.error = () => {};
    try {
      const startedAt = performance.now();
      const response = await fetch(`${app.base}/things/1`);
      expect(response.status).toBe(200);
      expect(performance.now() - startedAt).toBeLessThan(250);
    } finally {
      console.error = originalError;
      release();
      await app.dispose();
    }
  });

  test("rejects an invalid scope disposal timeout at startup", async () => {
    await expect(startServer({ requestScopeDisposeTimeoutMs: -1 })).rejects.toThrow(
      "requestScopeDisposeTimeoutMs",
    );
  });
});

describe("HTTP: generated API docs", () => {
  test("documents routes with global prefix and serves UI outside the API prefix", async () => {
    const app = await startServer({ prefix: "api", docs: { title: "Things API" } });
    try {
      const json = await fetch(`${app.base}/docs/openapi.json`);
      expect(json.status).toBe(200);
      const spec = (await json.json()) as { info: { title: string }; paths: Record<string, unknown> };
      expect(spec.info.title).toBe("Things API");
      expect(spec.paths["/api/things/{id}"]).toBeDefined();

      const ui = await fetch(`${app.base}/docs`);
      expect(ui.status).toBe(200);
      expect(await ui.text()).toContain("Things API");
    } finally {
      await app.dispose();
    }
  });
});
