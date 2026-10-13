import { expect, test } from "bun:test";
import { createToken } from "@/core/di";
import { Bazis, StartupFailuresError, StartupReport, defineConfig, secret } from "@/core/kernel";
import { Infra, InfraError, llmConnect, openAiCompatibleAdapter, openSearchConnect, type InfraConnector } from "@/core/infra";

function closedPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

function fake(name: string, outcome: "ok" | "fail"): InfraConnector<object> {
  return {
    token: createToken<object>(`Fake${name}`),
    create: () => ({}),
    connect: async () => { if (outcome === "fail") throw new InfraError(`Infra connector "${name}": refused`); },
    dispose: () => undefined,
    describe: (_client, { connected }) => ({ kind: connected ? "Fake 1.2" : "Fake", address: `${name}.local:1`, settings: [`BAZIS_${name.toUpperCase()}__URL`] }),
  };
}

test("every connection is recorded with what it connects to, and failures together", async () => {
  @Infra({ db: fake("db", "fail"), cache: fake("cache", "fail"), search: fake("search", "ok") })
  class AppInfra {}
  const kernel = await Bazis.createBuilder(AppInfra).useEnvironment("test").useStartupReport(false).build();
  const error = await kernel.start().then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(StartupFailuresError);
  expect((error as StartupFailuresError).failures.map((failure) => failure.name)).toEqual(["infra:db", "infra:cache"]);
  const connections = kernel.report.connections;
  expect(connections.map((connection) => [connection.name, connection.status, connection.kind])).toEqual([
    ["db", "down", "Fake"],
    ["cache", "down", "Fake"],
    ["search", "up", "Fake 1.2"],
  ]);
  expect(connections[0]?.settings).toEqual(["BAZIS_DB__URL"]);
  expect((connections[0]?.error as Error).message).toBe('Infra connector "db": refused');
  expect(kernel.report).toBeInstanceOf(StartupReport);
});

test("an OpenSearch that does not answer names its address", async () => {
  const url = `http://127.0.0.1:${closedPort()}`;
  const connector = openSearchConnect(defineConfig("search", { default: { url, username: "admin", password: secret("x") } }), { timeoutMs: 500 });
  const client = connector.create();
  const error = await Promise.resolve(connector.connect(client)).then(() => undefined, (caught: unknown) => caught);
  connector.dispose(client);
  expect(error).toBeInstanceOf(InfraError);
  expect((error as Error).message).toStartWith(`Infra connector "opensearch": cannot reach ${url} — `);
});

test("the LLM provider is checked at start: a refused key stops the start, checkOnStart: false skips it", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const config = defineConfig("llm", { default: { provider: "openai", model: "m", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: secret("wrong") } });
    const checked = llmConnect(config, openAiCompatibleAdapter());
    const provider = checked.create();
    const error = await Promise.resolve(checked.connect(provider)).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(InfraError);
    expect((error as Error).message).toStartWith(`Infra connector "llm": http://127.0.0.1:${server.port}/v1 is not available — `);
    expect((error as Error).message).not.toContain("wrong");
    expect(requests).toEqual(["GET /v1/models"]);

    const unchecked = llmConnect(config, openAiCompatibleAdapter(), { checkOnStart: false });
    await unchecked.connect(unchecked.create());
    expect(requests).toHaveLength(1);
    const description = await unchecked.describe?.(unchecked.create(), { connected: true });
    expect(description).toMatchObject({ kind: "openai · m", address: `http://127.0.0.1:${server.port}/v1` });
  } finally {
    server.stop(true);
  }
});
