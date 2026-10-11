import { describe, expect, test } from "bun:test";
import { DI, createToken, type BazisModuleRef } from "../../di";
import { AGENT_MODEL_PROVIDER, agentMessage, agentModelResponse, type AgentModelProvider } from "../../agent";
import { infraModule, llmConnect, llmProfile, llmRouter, type InfraConnector, type LlmConnectionOptions } from "../../infra";
import { ConfigRegistry, Configuration, Bazis, defineConfig, envSource, memorySource, secret } from "../index";

const builder = (root: BazisModuleRef, environment: "test" | "production" = "test") =>
  Bazis.createBuilder(root).useEnvironment(environment).useStartupReport(false)
    .useSignals([]).useUnhandledErrorPolicy("none");

function sharedGraph() {
  const declaration = defineConfig("kernel_isolation", {
    default: { mode: "default", enabled: false, count: 1, password: secret("test-key") },
    test: { mode: "test" }, production: { mode: "prod", password: secret() },
  });
  const service = createToken<{ read(): string }>("ConfigConsumer");
  const client = createToken<{ read(): string; closed: boolean }>("ConfigClient");
  let allocations = 0;
  const connector: InfraConnector<{ read(): string; closed: boolean }> = {
    token: client, config: declaration,
    create(configs) {
      allocations++;
      const values = configs!.get(declaration);
      return { read: () => values.get("mode"), closed: false };
    },
    connect() {}, dispose(value) { value.closed = true; },
  };
  const root = {
    config: [declaration, declaration], imports: [infraModule({ isolated: connector })],
    providers: [DI.singleton(DI.factoryProvider(service, [declaration.token], values => ({ read: () => values.get("mode") })))],
  };
  return { declaration, service, client, root, allocations: () => allocations };
}

describe("configuration ownership per kernel", () => {
  test("one shared graph supports concurrent production and test services/connectors", async () => {
    const graph = sharedGraph();
    const [production, testing] = await Promise.all([
      builder(graph.root, "production").addConfigSource(memorySource({ kernel_isolation: { password: "prod-key" } })).build(),
      builder(graph.root).addConfigSource(memorySource({})).build(),
    ]);
    try {
      await Promise.all([production.start(), testing.start()]);
      const results = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        const kernel = index % 2 === 0 ? production : testing;
        await Promise.resolve();
        return [kernel.container.resolve(graph.service).read(), kernel.container.resolve(graph.client).read()];
      }));
      expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? ["prod", "prod"] : ["test", "test"]));
      expect(production.container.resolve(graph.declaration.token).get("password").reveal()).toBe("prod-key");
      expect(testing.container.resolve(graph.declaration.token).get("password").reveal()).toBe("test-key");
    } finally { await Promise.all([production.stop(), testing.stop()]); }
  });

  test("equal environment names do not share resolved values or cache", async () => {
    const graph = sharedGraph();
    const [first, second] = await Promise.all([
      builder(graph.root).addConfigSource(memorySource({ kernel_isolation: { mode: "first" } })).build(),
      builder(graph.root).addConfigSource(memorySource({ kernel_isolation: { mode: "second" } })).build(),
    ]);
    try {
      const a = first.container.resolve(graph.declaration.token);
      const b = second.container.resolve(graph.declaration.token);
      expect(a).not.toBe(b);
      expect(first.container.resolve(ConfigRegistry).get(graph.declaration)).toBe(a);
      expect(first.container.resolve(ConfigRegistry).get(graph.declaration)).toBe(a);
      expect(a.get("mode")).toBe("first");
      expect(b.get("mode")).toBe("second");
    } finally { await Promise.all([first.stop(), second.stop()]); }
  });

  test("failed build leaves another kernel and the declaration reusable", async () => {
    const graph = sharedGraph();
    const first = await builder(graph.root).addConfigSource(memorySource({})).build();
    try {
      await expect(builder(graph.root, "production").addConfigSource(memorySource({})).build()).rejects.toThrow(/password/);
      expect(graph.allocations()).toBe(0);
      expect(first.container.resolve(graph.declaration.token).get("mode")).toBe("test");
      const retry = await builder(graph.root, "production")
        .addConfigSource(memorySource({ kernel_isolation: { password: "retry-key" } })).build();
      try { expect(retry.container.resolve(graph.declaration.token).get("password").reveal()).toBe("retry-key"); }
      finally { await retry.stop(); }
    } finally { await first.stop(); }
  });

  test("stopping one kernel does not close another client or replace its configuration", async () => {
    const graph = sharedGraph();
    const first = await builder(graph.root).addConfigSource(memorySource({ kernel_isolation: { mode: "first" } })).build();
    const second = await builder(graph.root).addConfigSource(memorySource({ kernel_isolation: { mode: "second" } })).build();
    try {
      await Promise.all([first.start(), second.start()]);
      const a = first.container.resolve(graph.client), b = second.container.resolve(graph.client);
      await first.stop();
      expect(a.closed).toBe(true);
      expect(b.closed).toBe(false);
      expect(b.read()).toBe("second");
      expect(second.container.resolve(graph.service).read()).toBe("second");
    } finally { await Promise.all([first.stop(), second.stop()]); }
  });

  test("schema and env source changes cannot change existing snapshots", async () => {
    const schema = { default: { mode: "before" }, production: { mode: "prod" } };
    const declaration = defineConfig("owned", schema);
    schema.default.mode = "mutated-default";
    schema.production.mode = "mutated-prod";
    const variables = { BAZIS_OWNED__MODE: "first" };
    const root = { config: declaration };
    const first = await builder(root).addConfigSource(envSource({ variables })).build();
    variables.BAZIS_OWNED__MODE = "second";
    const second = await builder(root).addConfigSource(envSource({ variables })).build();
    try {
      expect(Object.isFrozen(declaration)).toBe(true);
      expect(declaration.resolve("test", Configuration.empty()).get("mode")).toBe("before");
      expect(declaration.resolve("production", Configuration.empty()).get("mode")).toBe("prod");
      expect(first.container.resolve(declaration.token).get("mode")).toBe("first");
      expect(second.container.resolve(declaration.token).get("mode")).toBe("second");
    } finally { await Promise.all([first.stop(), second.stop()]); }
  });

  test("equal namespaces do not collapse different declaration identities", async () => {
    const a = defineConfig("same", { default: { value: "a" } });
    const b = defineConfig("same", { default: { value: "b" } });
    const kernel = await builder({ config: [a, b] }).addConfigSource(memorySource({})).build();
    try {
      expect(kernel.container.resolve(a.token).get("value")).toBe("a");
      expect(kernel.container.resolve(b.token).get("value")).toBe("b");
      expect(() => kernel.container.resolve(ConfigRegistry).get(defineConfig({ default: { value: "unknown" } }))).toThrow(/not declared/);
    } finally { await kernel.stop(); }
  });

  test("typed defaults, environment overrides, source precedence and Secret stay intact", async () => {
    const graph = sharedGraph();
    const kernel = await builder(graph.root, "production")
      .addConfigSource(memorySource({ kernel_isolation: { count: 2, enabled: false, password: "earlier" } }))
      .addConfigSource(memorySource({ kernel_isolation: { count: 7, enabled: true, password: "sensitive-test-value" } })).build();
    try {
      const config = kernel.container.resolve(graph.declaration.token);
      expect(config.get("mode")).toBe("prod");
      expect(config.get("count")).toBe(7);
      expect(config.get("enabled")).toBe(true);
      expect(config.get("password").reveal()).toBe("sensitive-test-value");
      expect(JSON.stringify(kernel.container.resolve(ConfigRegistry).inspect())).not.toContain("sensitive-test-value");
      expect(Object.isFrozen(config)).toBe(true);
    } finally { await kernel.stop(); }
  });
});

describe("built-in connector configuration isolation", () => {
  for (const routed of [false, true]) {
    test(`${routed ? "deferred LLM router" : "LLM connector"} uses its kernel view`, async () => {
      const declaration = defineConfig("isolation_llm", {
        default: { provider: "local-test", model: "test-model", baseUrl: "https://example.invalid", apiKey: secret("test-key") },
        production: { model: "prod-model", apiKey: secret("prod-key") },
      });
      const created: LlmConnectionOptions[] = [];
      const adapter = { kind: "isolation-probe", create(options: LlmConnectionOptions): AgentModelProvider {
        created.push(options);
        return { complete(request) { return agentModelResponse({ invocationId: request.invocationId, finishReason: "stop", message: agentMessage("assistant", options.model) }); } };
      } };
      const connector = routed
        ? llmRouter({ main: llmProfile(declaration, adapter) }, { defaultProfile: "main" })
        : llmConnect(declaration, adapter);
      const root = infraModule({ model: connector });
      const production = await builder(root, "production").addConfigSource(memorySource({})).build();
      const testing = await builder(root).addConfigSource(memorySource({})).build();
      try {
        // Force creation after both kernels have completed configuration.
        production.container.resolve(AGENT_MODEL_PROVIDER);
        testing.container.resolve(AGENT_MODEL_PROVIDER);
        await production.start();
        await testing.start();
        expect(created.map(value => value.model)).toEqual(["prod-model", "test-model"]);
      } finally { await Promise.all([production.stop(), testing.stop()]); }
    });
  }
});
