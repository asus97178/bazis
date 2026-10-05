import { describe, expect, test } from "bun:test";
import { createContainer, createToken, DI, HOSTED_SERVICE } from "../../di";
import { Osnv, defineConfig, secret } from "../../kernel";
import { infraModule, InfraLifecycle, llmProfile, llmRouter, type InfraConnector } from "../index";

describe("Infra audit resource ownership", () => {
  function connector(name: string, events: string[]): InfraConnector<object> {
    return {
      token: createToken<object>(name),
      create() { events.push(`create:${name}`); return {}; },
      connect() { events.push(`connect:${name}`); },
      dispose() { events.push(`dispose:${name}`); },
    };
  }

  test("container closes an early-resolved client without hosted start", async () => {
    const events: string[] = [];
    const resource = connector("early", events);
    const container = createContainer(infraModule({ early: resource }));
    container.resolve(resource.token);
    await container.dispose();
    expect(events).toEqual(["create:early", "dispose:early"]);
  });

  test("failed later factory releases earlier eagerly-resolved resources", async () => {
    const events: string[] = [];
    const first = connector("first", events);
    const second = { ...connector("second", events), create() { throw new Error("factory failed"); } };
    const kernel = await Osnv.createBuilder({
      imports: [infraModule({ first, second })],
      providers: [DI.singleton(DI.factoryProvider(HOSTED_SERVICE, [first.token, second.token], () => ({ start() {}, stop() {} })))],
    }).useEnvironment("test").useStartupReport(false).build();
    await expect(kernel.start()).rejects.toThrow();
    expect(events).toEqual(["create:first", "dispose:first"]);
  });

  test("failed connect closes even a later client resolved before startup", async () => {
    const events: string[] = [];
    const first = { ...connector("first", events), connect() { throw new Error("connect failed"); } };
    const later = connector("later", events);
    const kernel = await Osnv.createBuilder(infraModule({ first, later }))
      .useEnvironment("test").useStartupReport(false).build();
    kernel.container.resolve(later.token);
    await expect(kernel.start()).rejects.toThrow();
    expect(events.filter(event => event.startsWith("dispose:"))).toEqual(["dispose:first", "dispose:later"]);
  });

  test("abort releases the client before a pending connect settles", async () => {
    const events: string[] = [];
    let rejectConnect!: (error: Error) => void;
    let receivedSignal: AbortSignal | undefined;
    const resource = {
      ...connector("pending", events),
      connect(_client: object, signal?: AbortSignal) {
        receivedSignal = signal;
        return new Promise<void>((_resolve, reject) => { rejectConnect = reject; });
      },
    };
    const lifetime = new InfraLifecycle("pending", resource);
    const controller = new AbortController();
    const start = lifetime.start(controller.signal);
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await expect(start).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
    expect(events).toEqual(["create:pending", "dispose:pending"]);
    rejectConnect(new Error("late failure"));
    await lifetime.stop();
    await lifetime.dispose();
    expect(events).toHaveLength(2);
  });

  test("duplicate tokens across imported infra modules fail before creation", () => {
    const events: string[] = [];
    const first = connector("a", events);
    const second = { ...connector("b", events), token: first.token };
    expect(() => createContainer({ imports: [infraModule({ a: first }), infraModule({ b: second })] }))
      .toThrow(/share the same connector token/);
    expect(events).toEqual([]);
  });

  test("LLM adapter creation failure awaits asynchronous rollback", async () => {
    const events: string[] = [];
    const config = defineConfig("audit.llm", { default: { provider: "test", model: "test", baseUrl: "https://example.invalid", apiKey: secret("test") } });
    const resource = llmRouter({
      a: llmProfile(config, {
        create() { events.push("create:a"); return { complete: async () => { throw new Error("not dispatched"); } }; },
        async dispose() { await Promise.resolve(); events.push("dispose:a"); },
      }),
      b: llmProfile(config, { create() { throw new Error("adapter failed"); } }),
    }, { defaultProfile: "a" });
    const client = resource.create();
    await expect(resource.connect(client)).rejects.toThrow("adapter failed");
    expect(events).toEqual(["create:a", "dispose:a"]);
    await resource.dispose(client);
    expect(events).toHaveLength(2);
  });
});
