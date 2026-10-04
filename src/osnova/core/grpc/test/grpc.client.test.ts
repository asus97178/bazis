import { expect, test } from "bun:test";
import { createContainer, Module, HOSTED_SERVICE, singletonFactory, ModuleEncapsulationError, type Class } from "../../di";
import { GrpcClient, grpcClientProvider, GrpcController, GrpcMethod, grpcModule, GrpcServer,
  GrpcError, GrpcStatus as Status, Metadata, type GrpcContext, type GrpcClientOptions } from "../index";
import { echoService, type EchoMessage } from "./fixtures/contract";

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []; for await (const value of source) result.push(value); return result;
}

@GrpcController(echoService)
class EchoController {
  @GrpcMethod("Echo")
  async echo(input: EchoMessage, context: GrpcContext): Promise<EchoMessage> {
    if (input.text === "error") {
      const trailers = new Metadata(); trailers.set("reason-bin", Buffer.from([0, 255]));
      throw new GrpcError(Status.NOT_FOUND, "Не найдено", trailers);
    }
    if (input.text === "wait") await new Promise<void>(resolve => {
      if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const headers = new Metadata(); headers.set("x-server", "osnova"); context.sendMetadata(headers);
    return { text: input.text || context.metadata.get("x-text").join("|"), count: input.count + 1 };
  }
  @GrpcMethod("Expand")
  async *expand(input: EchoMessage, context: GrpcContext) {
    for (let count = 0; count < input.count; count++) yield { text: input.text, count };
    if (input.text === "error") throw new GrpcError(Status.NOT_FOUND, "Stream failed.");
    if (input.text === "wait") await new Promise<void>(resolve => {
      if (context.signal.aborted) resolve(); else context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  @GrpcMethod("Collect")
  async sum(inputs: AsyncIterable<EchoMessage>) {
    let count = 0; for await (const input of inputs) count += input.count; return { text: "sum", count };
  }
  @GrpcMethod("Chat")
  async *chat(inputs: AsyncIterable<EchoMessage>) { for await (const input of inputs) yield { text: input.text, count: input.count + 1 }; }
}

async function fixture(options: Partial<GrpcClientOptions> = {}, controller: Class<object> = EchoController) {
  const container = createContainer(grpcModule({ controllers: [controller], address: "127.0.0.1:0" }));
  const server = container.resolveAll(HOSTED_SERVICE).find((s): s is GrpcServer => s instanceof GrpcServer)!;
  await server.start();
  const client = new GrpcClient(echoService, { address: `127.0.0.1:${server.port}`, timeoutMs: 2000, ...options });
  return { client, server, async close() { client.close(); await server.stop(); await container.dispose(); } };
}

test("GrpcClient: unary aliases, metadata snapshots, all streaming modes and concurrent reuse", async () => {
  const defaults = new Metadata(); defaults.set("x-text", "default");
  const f = await fixture({ metadata: defaults });
  try {
    defaults.set("x-text", "changed");
    const metadata = new Metadata(); metadata.set("x-text", "call");
    const pending = f.client.unary<EchoMessage, EchoMessage>("echo", { text: "", count: 1 }, { metadata });
    metadata.set("x-text", "mutated");
    const result = await pending;
    expect(result.data).toEqual({ text: "default, call", count: 2 });
    expect(result.metadata.get("x-server")).toEqual(["osnova"]);
    expect(result.trailers).toBeInstanceOf(Metadata);
    expect((await f.client.unary<EchoMessage, EchoMessage>("Echo", { text: "ok", count: 2 })).data.count).toBe(3);
    const output = f.client.serverStream<EchoMessage, EchoMessage>("Expand", { text: "x", count: 3 });
    expect((await collect(output)).map(x => x.count)).toEqual([0, 1, 2]);
    expect(await output.trailers).toBeInstanceOf(Metadata);
    expect(() => output[Symbol.asyncIterator]()).toThrow("once");
    expect((await f.client.clientStream<EchoMessage, EchoMessage>("Collect", [{ text: "", count: 2 }, { text: "", count: 3 }])).data).toEqual({ text: "sum", count: 5 });
    async function* source() { yield { text: "a", count: 5 }; await Bun.sleep(1); yield { text: "b", count: 9 }; }
    expect(await collect(f.client.bidi<EchoMessage, EchoMessage>("Chat", source()))).toEqual([{ text: "a", count: 6 }, { text: "b", count: 10 }]);
    const parallel = await Promise.all(Array.from({ length: 25 }, (_, count) => f.client.unary<EchoMessage, EchoMessage>("Echo", { text: "p", count })));
    expect(parallel.map(x => x.data.count)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(f.client.activeCalls).toBe(0);
  } finally { await f.close(); }
});

test("GrpcClient: remote errors/trailers and partial stream are not successes", async () => {
  const f = await fixture();
  try {
    const error = await f.client.unary("Echo", { text: "error" }).catch(error => error);
    expect(error).toBeInstanceOf(GrpcError); expect(error.code).toBe(Status.NOT_FOUND);
    expect(error.message).toBe("Не найдено"); expect(error.metadata.get("reason-bin")).toEqual([Buffer.from([0, 255])]);
    const output = f.client.serverStream<EchoMessage, EchoMessage>("Expand", { text: "error", count: 2 });
    const values: number[] = [];
    const streamError = await (async () => { for await (const item of output) values.push(item.count); })().then(() => null, error => error);
    expect(streamError).toMatchObject({ code: Status.NOT_FOUND });
    expect(values).toEqual([0, 1]); await expect(output.trailers).rejects.toMatchObject({ code: Status.NOT_FOUND });
    expect(f.client.activeCalls).toBe(0);
  } finally { await f.close(); }
});

test("GrpcClient: messages larger than the HTTP/2 flow-control window round-trip", async () => {
  const f = await fixture();
  try {
    const text = "x".repeat(256 * 1024);
    const result = await f.client.unary<EchoMessage, EchoMessage>("Echo", { text, count: 10 });
    expect(result.data).toEqual({ text, count: 11 });
    expect(f.client.activeCalls).toBe(0);
  } finally { await f.close(); }
});

test("GrpcClient: deadlines, AbortSignal, early iteration exit and unobserved streams release calls", async () => {
  const f = await fixture();
  try {
    await expect(f.client.unary("Echo", { text: "wait" }, { timeoutMs: 30 })).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED });
    await expect(f.client.unary("Echo", { text: "wait" }, { deadline: new Date(Date.now() + 30) })).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED });
    const abort = new AbortController();
    const pending = f.client.unary("Echo", { text: "wait" }, { signal: abort.signal });
    abort.abort(); await expect(pending).rejects.toMatchObject({ code: Status.CANCELLED });
    const stream = f.client.serverStream<EchoMessage, EchoMessage>("Expand", { text: "wait", count: 1 });
    for await (const item of stream) { expect(item.count).toBe(0); break; }
    await expect(stream.trailers).rejects.toMatchObject({ code: Status.CANCELLED });
    const unused = f.client.serverStream("Expand", { count: 0 }, { timeoutMs: 30 });
    await expect(unused.trailers).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED });
    const beforeFirstRead = f.client.serverStream("Expand", { text: "wait", count: 1 });
    await beforeFirstRead[Symbol.asyncIterator]().return!();
    await expect(beforeFirstRead.trailers).rejects.toMatchObject({ code: Status.CANCELLED });
    expect(f.client.activeCalls).toBe(0);
    await eventually(() => f.server.activeCalls === 0);
  } finally { await f.close(); }
});

test("GrpcClient: limits and terminal close reject new calls; no queue", async () => {
  const f = await fixture({ maxConcurrentCalls: 1, maxSendMessageLength: 32, maxReceiveMessageLength: 32 });
  try {
    const pending = f.client.unary("Echo", { text: "wait" });
    await expect(f.client.unary("Echo", {})).rejects.toMatchObject({ code: Status.RESOURCE_EXHAUSTED });
    f.client.close(); f.client.dispose();
    await expect(pending).rejects.toMatchObject({ code: Status.CANCELLED });
    await expect(f.client.unary("Echo", {})).rejects.toMatchObject({ code: Status.CANCELLED });
    expect(f.client.activeCalls).toBe(0);
  } finally { await f.close(); }
  const limited = await fixture({ maxSendMessageLength: 4 });
  try { await expect(limited.client.unary("Echo", { text: "too long" })).rejects.toMatchObject({ code: Status.RESOURCE_EXHAUSTED }); }
  finally { await limited.close(); }
});

test("GrpcClient: non-cooperative upload is cancelled without waiting for iterator.return", async () => {
  const f = await fixture();
  let next = 0, returned = 0;
  const source: AsyncIterable<EchoMessage> = { [Symbol.asyncIterator]() { return {
    next: () => { next++; return new Promise(() => {}); },
    return: () => { returned++; return new Promise(() => {}); },
  }; } };
  try {
    await expect(f.client.clientStream("Collect", source, { timeoutMs: 30 })).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED });
    expect(next).toBe(1); expect(returned).toBe(1); expect(f.client.activeCalls).toBe(0);
    expect((await f.client.unary("Echo", { text: "alive" })).data).toMatchObject({ text: "alive" });
  } finally { await f.close(); }
});

test("GrpcClient: configuration, mode and expired-call validation happens before network", async () => {
  const options = { address: "127.0.0.1:1" };
  for (const changes of [{ timeoutMs: 0 }, { timeoutMs: NaN }, { tls: {} }, { metadata: null }, { extra: true }, { maxConcurrentCalls: -1 }, { address: "http://host/path" }, { address: "http://user:pass@host" }, { address: "ftp://host" }]) {
    expect(() => new GrpcClient(echoService, { ...options, ...changes } as GrpcClientOptions)).toThrow();
  }
  const client = new GrpcClient(echoService, options);
  try {
    await expect(client.unary("missing", {})).rejects.toBeInstanceOf(TypeError);
    await expect(client.unary("Chat", {})).rejects.toBeInstanceOf(TypeError);
    await expect(client.clientStream("Collect", {} as never)).rejects.toBeInstanceOf(TypeError);
    await expect(client.unary("Echo", {}, { timeoutMs: null } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(client.unary("Echo", {}, { deadline: 0 })).rejects.toMatchObject({ code: Status.DEADLINE_EXCEEDED });
    await expect(client.unary("Echo", {}, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: Status.CANCELLED });
    await expect(client.unary("Echo", {})).rejects.toMatchObject({ code: Status.UNAVAILABLE });
    expect(client.activeCalls).toBe(0);
  } finally { client.close(); }
});

test("grpcClientProvider: ordinary singleton ownership, private visibility and disposal per container", async () => {
  const f = await fixture();
  const provider = grpcClientProvider(echoService, { address: `127.0.0.1:${f.server.port}`, timeoutMs: 2000 });
  @Module({ providers: [provider], exports: [] }) class PrivateFeature {}
  class Consumer { constructor(readonly client: GrpcClient) {} }
  expect(() => createContainer({ imports: [PrivateFeature], providers: [singletonFactory(Consumer, [GrpcClient], client => new Consumer(client))] })).toThrow(ModuleEncapsulationError);
  @Module({ providers: [provider], exports: [GrpcClient] }) class Feature {}
  const first = createContainer(Feature), second = createContainer(Feature);
  try {
    const a = first.resolve(GrpcClient), b = second.resolve(GrpcClient);
    expect(a).toBe(first.resolve(GrpcClient)); expect(a).not.toBe(b);
    const active = a.unary("Echo", { text: "wait" });
    await first.dispose();
    await expect(active).rejects.toMatchObject({ code: Status.CANCELLED });
    await expect(a.unary("Echo", {})).rejects.toMatchObject({ code: Status.CANCELLED });
    expect((await b.unary("Echo", { text: "independent" })).data).toMatchObject({ text: "independent" });
  } finally { await first.dispose(); await second.dispose(); await f.close(); }
});
