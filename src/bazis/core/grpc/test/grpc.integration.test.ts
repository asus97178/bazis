import { describe, expect, test } from "bun:test";
import { Metadata, GrpcStatus as status } from "../index";
import type { ServiceError, ClientReadableStream } from "./fixtures/nativeClient";
import { DI, HOSTED_SERVICE, Module, createContainer, scoped, type Class } from "../../di";
import { Controller, Get, httpModule } from "../../http";
import { GrpcController, GrpcMethod, GrpcError, GrpcServer, grpcModule, type GrpcContext } from "../index";
import { echoClient, echoService, type EchoMessage } from "./fixtures/contract";

function unary(client: ReturnType<typeof echoClient>, message: Partial<EchoMessage>, metadata = new Metadata(), timeoutMs = 2000): Promise<EchoMessage> {
  return new Promise((resolve, reject) => client.Echo!(message, metadata, { deadline: Date.now() + timeoutMs },
    (error: ServiceError | null, response: EchoMessage) => error ? reject(error) : resolve(response)));
}
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  expect(check()).toBe(true);
}

@GrpcController(echoService)
class EchoController {
  @GrpcMethod("Echo")
  async echo(request: EchoMessage, context: GrpcContext): Promise<EchoMessage> {
    if (request.text === "public-error") throw new GrpcError(status.NOT_FOUND, "Missing message.");
    if (request.text === "private-error") throw new Error("database-password-secret");
    return { text: request.text || String(context.metadata.get("x-message")[0] ?? "empty"), count: request.count + 1 };
  }
  @GrpcMethod("Expand")
  async *expand(request: EchoMessage): AsyncGenerator<EchoMessage> {
    for (let i = 0; i < request.count; i++) yield { text: request.text, count: i };
  }
  @GrpcMethod("Collect")
  async collect(requests: AsyncIterable<EchoMessage>): Promise<EchoMessage> {
    let count = 0;
    for await (const request of requests) count += request.count;
    return { text: "collected", count };
  }
  @GrpcMethod("Chat")
  async *chat(requests: AsyncIterable<EchoMessage>): AsyncGenerator<EchoMessage> {
    for await (const request of requests) yield { text: request.text, count: request.count + 1 };
  }
}

async function fixture(controller: Class<object> = EchoController, options: Parameters<typeof grpcModule>[0] = {}) {
  @Module({ grpcControllers: [controller], exports: [] })
  class Feature {}
  const container = createContainer(grpcModule({ imports: [Feature], address: "127.0.0.1:0", ...options }));
  const server = container.resolveAll(HOSTED_SERVICE).find((s): s is GrpcServer => s instanceof GrpcServer)!;
  await server.start();
  const client = echoClient(server.port!);
  return { container, server, client, async close() { client.close(); await server.stop(); await container.dispose(); } };
}

describe("gRPC module: real HTTP/2 and protobuf", () => {
  test("discovers nested module controllers and metadata; coexists with HTTP", async () => {
    @Controller("health")
    class HttpController { @Get() get() { return "ok"; } }
    @Module({ grpcControllers: [EchoController], controllers: [HttpController], exports: [] })
    class Feature {}
    @Module({ imports: [Feature], exports: [] })
    class App {}
    const container = createContainer({ imports: [
      httpModule({ imports: [App], port: 0 }),
      grpcModule({ imports: [App], address: "127.0.0.1:0" }),
    ] });
    const services = container.resolveAll(HOSTED_SERVICE);
    const server = services.find((s): s is GrpcServer => s instanceof GrpcServer)!;
    expect(services).toHaveLength(2);
    const metadata = new Metadata();
    metadata.set("x-message", "from-metadata");
    await server.start();
    const client = echoClient(server.port!);
    try {
      expect(await unary(client, { count: 4 }, metadata)).toEqual({ text: "from-metadata", count: 5 });
    } finally { client.close(); await server.stop(); await container.dispose(); }
  });

  test("supports unary and server streaming", async () => {
    const f = await fixture();
    try {
      expect(await unary(f.client, { text: "hello", count: 1 })).toEqual({ text: "hello", count: 2 });
      const output: EchoMessage[] = [];
      for await (const message of f.client.Expand!({ text: "stream", count: 3 }, { deadline: Date.now() + 2000 }) as ClientReadableStream<EchoMessage>) output.push(message);
      expect(output.map((m) => m.count)).toEqual([0, 1, 2]);
    } finally { await f.close(); }
  });

  test("supports client streaming", async () => {
    const f = await fixture();
    try {
      const collected = new Promise<EchoMessage>((resolve, reject) => {
        const stream = f.client.Collect!({ deadline: Date.now() + 2000 }, (error: ServiceError | null, result: EchoMessage) => error ? reject(error) : resolve(result));
        stream.write({ count: 2 }); stream.write({ count: 3 }); stream.end();
      });
      expect(await collected).toEqual({ text: "collected", count: 5 });
    } finally { await f.close(); }
  });

  test("supports bidirectional streaming", async () => {
    const f = await fixture();
    try {
      const chat = f.client.Chat!({ deadline: Date.now() + 2000 });
      chat.write({ text: "a", count: 10 }); chat.write({ text: "b", count: 20 }); chat.end();
      const replies: EchoMessage[] = [];
      for await (const message of chat) replies.push(message);
      expect(replies).toEqual([{ text: "a", count: 11 }, { text: "b", count: 21 }]);
    } finally { await f.close(); }
  });

  test("maps explicit errors and redacts unexpected exceptions", async () => {
    const f = await fixture();
    try {
      await expect(unary(f.client, { text: "public-error" })).rejects.toMatchObject({ code: status.NOT_FOUND, details: "Missing message." });
      await expect(unary(f.client, { text: "private-error" })).rejects.toMatchObject({ code: status.INTERNAL, details: "Internal server error." });
    } finally { await f.close(); }
  });

  test("private dependencies get one scope per RPC and are disposed on success/error", async () => {
    let created = 0, disposed = 0;
    class Dependency { readonly id = ++created; dispose() { disposed++; } }
    @GrpcController(echoService)
    class ScopedController extends EchoController {
      constructor(private readonly dependency: Dependency) { super(); }
      override async echo(request: EchoMessage, context: GrpcContext) {
        const value = await super.echo(request, context);
        return { ...value, count: this.dependency.id };
      }
    }
    @Module({ providers: [scoped(Dependency)], grpcControllers: [DI.bindDeps(ScopedController, Dependency)], exports: [] })
    class PrivateFeature {}
    const f = await fixture(EchoController, { imports: [PrivateFeature] });
    try {
      expect((await unary(f.client, { text: "one" })).count).toBe(1);
      expect((await unary(f.client, { text: "two" })).count).toBe(2);
      const failure = await unary(f.client, { text: "private-error" }).catch((error: ServiceError) => error);
      expect(failure).toMatchObject({ code: status.INTERNAL });
      expect(created).toBe(3); expect(disposed).toBe(3);
    } finally { await f.close(); }
  });

  test("deadline reaches AbortSignal and cleanup waits for handler completion", async () => {
    let aborted = false, completed = false, disposed = false;
    @GrpcController(echoService)
    class SlowController extends EchoController {
      override async echo(_request: EchoMessage, context: GrpcContext): Promise<EchoMessage> {
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
        await Bun.sleep(30);
        expect(disposed).toBe(false);
        completed = true;
        return { text: "late", count: 0 };
      }
      dispose() { disposed = true; }
    }
    const f = await fixture(SlowController);
    try {
      await expect(unary(f.client, { text: "wait" }, undefined, 500)).rejects.toMatchObject({ code: status.DEADLINE_EXCEEDED });
      await eventually(() => aborted && completed && disposed && f.server.activeCalls === 0);
    } finally { await f.close(); }
  });

  test("cancels a client stream waiting for input and releases its scope", async () => {
    let disposed = false;
    class StreamingController extends EchoController { dispose() { disposed = true; } }
    const f = await fixture(StreamingController);
    try {
      const result = new Promise<ServiceError | null>((resolve) => {
        const stream = f.client.Collect!((error: ServiceError | null) => resolve(error));
        stream.write({ count: 1 });
        setTimeout(() => stream.cancel(), 100);
      });
      expect((await result)?.code).toBe(status.CANCELLED);
      await eventually(() => disposed && f.server.activeCalls === 0);
    } finally { await f.close(); }
  });

  test("limits concurrent work including cancelled handlers and forces bounded shutdown", async () => {
    let finish!: () => void;
    class HeldController extends EchoController {
      override async echo(): Promise<EchoMessage> {
        await new Promise<void>((resolve) => { finish = resolve; });
        return { text: "done", count: 1 };
      }
    }
    const f = await fixture(HeldController, { maxConcurrentCalls: 1, shutdownTimeoutMs: 60 });
    const first = unary(f.client, {}).catch((error: ServiceError) => error);
    try {
      await eventually(() => f.server.activeCalls === 1);
      await expect(unary(f.client, {})).rejects.toMatchObject({ code: status.RESOURCE_EXHAUSTED });
      await expect(f.server.stop()).rejects.toThrow("shutdown timed out");
      expect((await first as ServiceError).code).toBe(status.UNAVAILABLE);
    } finally {
      finish(); await eventually(() => f.server.activeCalls === 0);
      f.client.close(); await f.container.dispose();
    }
  });

  test("rejects duplicate routes, missing methods and duplicate provider ownership", async () => {
    class Duplicate extends EchoController {}
    expect(() => createContainer(grpcModule({ controllers: [EchoController, Duplicate] })).resolveAll(HOSTED_SERVICE))
      .toThrow("Duplicate gRPC method");
    @GrpcController(echoService)
    class Missing {}
    expect(() => createContainer(grpcModule({ controllers: [Missing] }))).toThrow("missing @GrpcMethod");
    expect(() => createContainer({ grpcControllers: [EchoController], providers: [scoped(EchoController)] }))
      .toThrow("both a module-owned contribution");
    expect(() => new GrpcError(status.OK, "invalid")).toThrow("non-OK");
  });

  test("a streaming failure preserves prior messages and disposes the controller", async () => {
    let disposed = false;
    class FailedStream extends EchoController {
      override async *expand(request: EchoMessage): AsyncGenerator<EchoMessage> {
        yield request;
        throw new Error("private-stream-secret");
      }
      dispose() { disposed = true; }
    }
    const f = await fixture(FailedStream);
    try {
      const messages: EchoMessage[] = [];
      let failure: unknown;
      try {
        for await (const message of f.client.Expand!({text: "first", count: 1}, {deadline: Date.now() + 2000})) messages.push(message);
      } catch (error) { failure = error; }
      expect(messages).toEqual([{text: "first", count: 1}]);
      expect(failure).toMatchObject({ code: status.INTERNAL, details: "Internal server error." });
      expect(disposed).toBe(true);
    } finally { await f.close(); }
  });

  test("two servers publish only their imported controller trees", async () => {
    class LeftController extends EchoController {
      override async echo(): Promise<EchoMessage> { return {text: "left", count: 1}; }
    }
    class RightController extends EchoController {
      override async echo(): Promise<EchoMessage> { return {text: "right", count: 2}; }
    }
    @Module({ grpcControllers: [LeftController], exports: [] }) class Left {}
    @Module({ grpcControllers: [RightController], exports: [] }) class Right {}
    const container = createContainer({imports: [
      grpcModule({imports: [Left], address: "127.0.0.1:0"}),
      grpcModule({imports: [Right], address: "127.0.0.1:0"}),
    ]});
    const servers = container.resolveAll(HOSTED_SERVICE) as GrpcServer[];
    await Promise.all(servers.map((server) => server.start()));
    const clients = servers.map((server) => echoClient(server.port!));
    try {
      const results = await Promise.all(clients.map((client) => unary(client, {})));
      expect(results.map((result) => result.text)).toEqual(["left", "right"]);
    } finally {
      clients.forEach((client) => client.close());
      await Promise.all(servers.map((server) => server.stop()));
      await container.dispose();
    }
  });

  test("rejects invalid options and startup cancellation without leaking a listener", async () => {
    for (const options of [{maxConcurrentCalls: 0}, {shutdownTimeoutMs: Infinity}, {phase: 0.5}, {address: ""}]) {
      const container = createContainer(grpcModule(options));
      try { expect(() => container.resolveAll(HOSTED_SERVICE)).toThrow(); }
      finally { await container.dispose(); }
    }
    const container = createContainer(grpcModule({controllers: [EchoController], address: "127.0.0.1:0"}));
    const server = container.resolveAll(HOSTED_SERVICE)[0] as GrpcServer;
    const abort = new AbortController();
    abort.abort(new Error("startup cancelled"));
    const failure = await server.start(abort.signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(server.port).toBeUndefined();
    await server.stop();
    const restart = await server.start().catch((error: unknown) => error);
    expect(restart).toBeInstanceOf(Error);
    await container.dispose();
  });

  test("disposal failure becomes INTERNAL and does not keep a concurrency slot", async () => {
    class BrokenDisposal extends EchoController {
      dispose() { throw new Error("private-disposal-error"); }
    }
    const f = await fixture(BrokenDisposal, {maxConcurrentCalls: 1});
    try {
      for (let i = 0; i < 3; i++) {
        const failure = await unary(f.client, {text: "ok"}).catch((error: ServiceError) => error);
        expect(failure).toMatchObject({code: status.INTERNAL, details: "Internal server error."});
        await eventually(() => f.server.activeCalls === 0);
      }
    } finally { await f.close(); }
  });
});
