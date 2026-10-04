import { describe, expect, test } from "bun:test";
import { Module, createContainer } from "@/core/di";
import {
  HTTP_CLIENT,
  HTTP_CLIENT_FACTORY,
  HttpClient,
  httpClientModule,
  type HttpClientFactory,
} from "@/core/http-client";
import { runWithRequestContextAsync } from "@/core/kernel";

function recordingFetch(): { fetch: typeof fetch; headersFor(host: string): Headers | undefined } {
  const byHost = new Map<string, Headers>();
  const impl = (async (url: string | URL, init?: RequestInit) => {
    byHost.set(new URL(String(url)).hostname, new Headers(init?.headers));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: impl, headersFor: (host) => byHost.get(host) };
}

function buildClient(extra: Record<string, unknown>): { client: HttpClient; container: ReturnType<typeof createContainer> } {
  @Module({ imports: [httpClientModule({ default: extra })] })
  class AppModule {}
  const container = createContainer(AppModule, { validateOnBuild: true });
  return { client: container.resolve(HTTP_CLIENT), container };
}

describe("httpClientModule: DI wiring", () => {
  test("provides HTTP_CLIENT and HTTP_CLIENT_FACTORY", () => {
    @Module({
      imports: [httpClientModule({ clients: { api: { baseUrl: "https://api.test" } } })],
    })
    class AppModule {}
    const container = createContainer(AppModule, { validateOnBuild: true });

    expect(container.resolve(HTTP_CLIENT)).toBeInstanceOf(HttpClient);
    const factory = container.resolve(HTTP_CLIENT_FACTORY) as HttpClientFactory;
    expect(factory.createClient("api")).toBeInstanceOf(HttpClient);
    expect(() => factory.createClient("nope")).toThrow();
  });

  test("applies bounded defaults without letting undefined erase them", () => {
    @Module({
      imports: [httpClientModule({
        timeoutMs: 12_345,
        maxResponseBytes: 1_234,
        default: { timeoutMs: undefined, maxResponseBytes: undefined },
        clients: { api: { baseUrl: "https://api.test", timeoutMs: undefined, maxResponseBytes: undefined } },
      })],
    })
    class AppModule {}
    const container = createContainer(AppModule, { validateOnBuild: true });

    expect(container.resolve(HTTP_CLIENT).defaults.timeoutMs).toBe(12_345);
    expect(container.resolve(HTTP_CLIENT).defaults.maxResponseBytes).toBe(1_234);
    const named = container.resolve(HTTP_CLIENT_FACTORY).createClient("api");
    expect(named.defaults.timeoutMs).toBe(12_345);
    expect(named.defaults.maxResponseBytes).toBe(1_234);
  });

  test("accepts explicit zero opt-outs", () => {
    @Module({ imports: [httpClientModule({ timeoutMs: 0, maxResponseBytes: 0 })] })
    class AppModule {}
    const container = createContainer(AppModule, { validateOnBuild: true });
    const client = container.resolve(HTTP_CLIENT);

    expect(client.defaults.timeoutMs).toBe(0);
    expect(client.defaults.maxResponseBytes).toBe(0);
  });

  test("rejects invalid module, default, and named-client limits at setup", () => {
    expect(() => httpClientModule({ timeoutMs: -1 })).toThrow("httpClientModule timeoutMs");
    expect(() => httpClientModule({ maxResponseBytes: 1.5 })).toThrow("httpClientModule maxResponseBytes");
    expect(() => httpClientModule({ default: { timeoutMs: Number.NaN } })).toThrow(
      "httpClientModule default.timeoutMs",
    );
    expect(() => httpClientModule({ clients: { api: { maxResponseBytes: Number.POSITIVE_INFINITY } } })).toThrow(
      "httpClientModule clients.api.maxResponseBytes",
    );
  });
});

describe("httpClientModule: correlation propagation", () => {
  test("same-origin (default): propagates kernel request id to the baseUrl host", async () => {
    const rec = recordingFetch();
    const { client } = buildClient({ baseUrl: "https://api.test", fetch: rec.fetch });

    await runWithRequestContextAsync({ requestId: "req-1", traceparent: "00-a-b-01" }, async () => {
      await client.get("/users");
    });

    expect(rec.headersFor("api.test")?.get("x-request-id")).toBe("req-1");
    expect(rec.headersFor("api.test")?.get("traceparent")).toBe("00-a-b-01");
  });

  test("does not leak correlation to a foreign host (secure default)", async () => {
    const rec = recordingFetch();
    const { client } = buildClient({ baseUrl: "https://api.test", fetch: rec.fetch });

    await runWithRequestContextAsync({ requestId: "req-2" }, async () => {
      await client.get("https://third-party.example/track");
    });

    expect(rec.headersFor("third-party.example")?.get("x-request-id")).toBeNull();
  });

  test("same-origin policy also requires the same scheme and port", async () => {
    const rec = recordingFetch();
    const { client } = buildClient({ baseUrl: "https://api.test", fetch: rec.fetch });

    await runWithRequestContextAsync({ requestId: "req-origin" }, async () => {
      await client.get("http://api.test:8080/track");
    });

    expect(rec.headersFor("api.test")?.get("x-request-id")).toBeNull();
  });

  test('propagateCorrelation "all" forwards to any host', async () => {
    const rec = recordingFetch();
    const { client } = buildClient({ fetch: rec.fetch, propagateCorrelation: "all" });

    await runWithRequestContextAsync({ requestId: "req-3" }, async () => {
      await client.get("https://anywhere.example/x");
    });

    expect(rec.headersFor("anywhere.example")?.get("x-request-id")).toBe("req-3");
  });
});
