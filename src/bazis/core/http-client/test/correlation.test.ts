import { describe, expect, test } from "bun:test";
import { Module, createContainer } from "@/core/di";
import { HttpClient, HttpClientBase, HttpClientError } from "@/core/http-client";
import { defineConfig, memorySource, runWithRequestContextAsync } from "@/core/kernel";
import { createTestContainer } from "@/core/testing";

function recordingFetch(): { fetch: typeof fetch; headersFor(host: string): Headers | undefined } {
  const byHost = new Map<string, Headers>();
  const impl = (async (url: string | URL, init?: RequestInit) => {
    byHost.set(new URL(String(url)).hostname, new Headers(init?.headers));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: impl, headersFor: (host) => byHost.get(host) };
}

function buildClient(extra: Record<string, unknown>): { client: HttpClientBase; container: ReturnType<typeof createContainer> } {
  @HttpClient(extra)
  class ApiClient extends HttpClientBase {}
  @Module({ httpClients: [ApiClient] })
  class AppModule {}
  const container = createContainer(AppModule, { validateOnBuild: true });
  return { client: container.resolve(ApiClient), container };
}

interface WeatherConfig { baseUrl: string; timeoutMs: number }
const weatherConfig = defineConfig<WeatherConfig>("weather", { default: { baseUrl: "https://weather.test", timeoutMs: 5000 } });

describe("@HttpClient in httpClients: DI wiring", () => {
  test("a declared client is injected by its class, with the server-side limits by default", () => {
    const { client } = buildClient({ baseUrl: "https://api.test" });
    expect(client).toBeInstanceOf(HttpClientBase);
    expect(client.defaults.baseUrl).toBe("https://api.test");
    expect(client.defaults.timeoutMs).toBe(30_000);
    expect(client.defaults.maxResponseBytes).toBe(16 * 1024 * 1024);
  });

  test("the base URL and limits come from the client's config; the module declares the config itself", async () => {
    @HttpClient({ config: weatherConfig, maxResponseBytes: 1234 })
    class WeatherClient extends HttpClientBase {}
    @Module({ httpClients: [WeatherClient] })
    class AppModule {}
    const container = await createTestContainer(AppModule, { configure: (builder) => builder.addConfigSource(memorySource({ weather: { baseUrl: "https://override.test" } })) });
    const client = container.resolve(WeatherClient);
    expect(client.defaults.baseUrl).toBe("https://override.test");
    expect(client.defaults.timeoutMs).toBe(5000);
    expect(client.defaults.maxResponseBytes).toBe(1234);
  });

  test("httpClients refuses a class without @HttpClient", () => {
    class Plain extends HttpClientBase {}
    @Module({ httpClients: [Plain] })
    class Broken {}
    expect(() => createContainer(Broken)).toThrow(HttpClientError);
    expect(() => createContainer(Broken)).toThrow("Broken: Plain in httpClients must extend HttpClientBase and be declared with @HttpClient(…).");
  });
});

describe("@HttpClient: correlation propagation", () => {
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
