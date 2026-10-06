import { expect, test } from "bun:test";
import { createContainer, HOSTED_SERVICE, Module } from "../../di";
import { getModelValidator, useModelValidator } from "../../http/Binding/modelValidator";
import { bindModel } from "../../http/Binding/modelBinder";
import { registerRequestModelShape } from "../../http/Binding/requestModelRegistry";
import { registerGeneratedProviderAttachments } from "../../di/module/generatedProviderAttachments";
import { Validator, modelValidatorAdapter } from "../../../library/validation";
import { GRPC_REQUEST_BINDINGS, GrpcClient, GrpcController, GrpcError, GrpcMethod, GrpcServer, GrpcStatus, grpcModule, type GrpcModuleOptions } from "../index";
import { GrpcRequestBinding } from "../GrpcRequest.binding";
import { echoClient, echoService, type EchoMessage } from "./fixtures/contract";

class EmailModel {
  @Validator({ required: true, minLength: 5, email: true }) text!: string;
}
class MessageModel extends EmailModel {
  @Validator({ required: true, positive: true }) count!: number;
}
const valid = { text: "user@example.test", count: 1 };

async function fixture(options: GrpcModuleOptions = {}, swallow = false) {
  const received: MessageModel[] = [];
  let disposed = 0;
  @GrpcController(echoService)
  class Controller {
    dispose() { disposed++; }
    @GrpcMethod("Echo", MessageModel)
    echo(input: MessageModel) { received.push(input); return input; }
    @GrpcMethod("Expand", MessageModel)
    async *expand(input: MessageModel) { received.push(input); yield input; }
    @GrpcMethod("Collect", MessageModel)
    async collect(input: AsyncIterable<MessageModel>) {
      let count = 0;
      try { for await (const item of input) { received.push(item); count += item.count; } }
      catch (error) { if (!swallow) throw error; }
      return { text: valid.text, count };
    }
    @GrpcMethod("Chat", MessageModel)
    async *chat(input: AsyncIterable<MessageModel>) {
      try { for await (const item of input) { received.push(item); yield item; } }
      catch (error) { if (!swallow) throw error; yield valid; }
    }
  }
  @Module({ grpcControllers: [Controller], exports: [] })
  class Feature {}
  const container = createContainer(grpcModule({ address: "127.0.0.1:0", imports: [Feature], ...options }));
  const server = container.resolveAll(HOSTED_SERVICE).find((item): item is GrpcServer => item instanceof GrpcServer)!;
  await server.start();
  const client = new GrpcClient(echoService, { address: `127.0.0.1:${server.port}`, timeoutMs: 2000 });
  return { server, client, received, get disposed() { return disposed; }, async close() {
    client.close(); await server.stop(); await container.dispose();
  } };
}

async function failure(operation: Promise<unknown>): Promise<GrpcError> {
  const result = await operation.then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(GrpcError);
  return result as GrpcError;
}
async function collect(input: AsyncIterable<unknown>): Promise<unknown[]> {
  const values = []; for await (const value of input) values.push(value); return values;
}
function details(error: GrpcError) {
  return JSON.parse((error.metadata!.get("bazis-validation-errors-bin")[0] as Buffer).toString());
}

test("unary validation runs before controller activation; independent peer receives field errors", async () => {
  const f = await fixture();
  const peer = echoClient(f.server.port!);
  try {
    expect((await f.client.unary("Echo", valid)).data).toEqual(valid);
    expect(f.received[0]).toBeInstanceOf(MessageModel);
    let trailers: Record<string, unknown> = {};
    const result = await new Promise<{ code: number }>((resolve, reject) => {
      const rpc = peer.Echo!({ text: "x", count: -1 }, { deadline: Date.now() + 2000 }, (error: { code: number } | null) => error ? resolve(error) : reject(new Error("Invalid input succeeded")));
      rpc.on("status", (values) => { trailers = values; });
      rpc.on("metadata", (values) => { trailers = values.toHttp2Headers(); }); // trailers-only response
    });
    expect(result.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    const errors = JSON.parse(Buffer.from(String(trailers["bazis-validation-errors-bin"]), "base64").toString());
    expect(errors.truncated).toBe(false);
    expect(errors.errors.map((item: { property: string }) => item.property)).toContain("text");
    expect(errors.errors.map((item: { property: string }) => item.property)).toContain("count");
    expect(f.received).toHaveLength(1);
    expect(f.disposed).toBe(1); // invalid unary never activates the scoped controller
    const missing = await failure(f.client.unary("Echo", {}));
    expect(missing.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    // defaults:true decodes absent text/count to ""/0; required checks null/undefined.
    expect(details(missing).errors.map((item: { code: string }) => item.code)).toContain("minLength");
    expect((await f.client.unary("Echo", valid)).data).toEqual(valid);
  } finally { peer.close(); await f.close(); }
});

test("all streaming modes validate each consumed DTO; invalid elements cannot reach or be swallowed by handlers", async () => {
  for (const swallow of [false, true]) {
    const f = await fixture({}, swallow);
    try {
      expect(await collect(f.client.serverStream("Expand", valid))).toEqual([valid]);
      const invalidExpand = await failure(collect(f.client.serverStream("Expand", { ...valid, count: -1 })));
      expect(invalidExpand.code).toBe(GrpcStatus.INVALID_ARGUMENT);
      const beforeCollect = f.received.length;
      const invalidCollect = await failure(f.client.clientStream("Collect", [valid, { ...valid, count: -1 }, valid]));
      expect(invalidCollect.code).toBe(GrpcStatus.INVALID_ARGUMENT);
      expect(f.received.length - beforeCollect).toBe(1);
      const replies: unknown[] = [];
      const invalidChat = await failure((async () => {
        for await (const item of f.client.bidi("Chat", [valid, { text: "bad", count: 1 }, valid])) replies.push(item);
      })());
      expect(invalidChat.code).toBe(GrpcStatus.INVALID_ARGUMENT);
      expect(replies).toEqual([valid]);
      expect(f.received.every((item) => item instanceof MessageModel && item.count > 0 && item.text === valid.text)).toBe(true);
      expect(f.server.activeCalls).toBe(0);
      expect(f.disposed).toBe(3); // successful Expand, failed Collect and Chat
    } finally { await f.close(); }
  }
});

test("validators are server-owned, isolated from the legacy HTTP bridge; exceptions are INTERNAL", async () => {
  const previous = getModelValidator();
  const reject = { validate: () => ({ isValid: false, errors: [{ property: "count", message: "Application limit", code: "limit" }] }) };
  const a = await fixture({ validator: reject });
  const b = await fixture();
  const c = await fixture({ validator: { validate() { throw new Error("private-validator-secret"); } } });
  try {
    useModelValidator(reject);
    const [error, success, internal] = await Promise.all([
      failure(a.client.unary("Echo", valid)), b.client.unary("Echo", valid), failure(c.client.unary("Echo", valid)),
    ]);
    expect(error.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    expect(details(error).errors[0].code).toBe("limit");
    expect(success.data).toEqual(valid);
    expect(internal.code).toBe(GrpcStatus.INTERNAL);
    expect(internal.message).toBe("Internal server error.");
  } finally {
    useModelValidator(previous ?? modelValidatorAdapter);
    await Promise.all([a.close(), b.close(), c.close()]);
  }
});

test("a validator throwing undefined cannot be swallowed into a successful streaming response", async () => {
  const f = await fixture({ validator: { validate() { throw undefined; } } }, true);
  try {
    const error = await failure(f.client.clientStream("Collect", [valid]));
    expect(error.code).toBe(GrpcStatus.INTERNAL);
    expect(f.received).toHaveLength(0);
    expect(f.disposed).toBe(1);
  } finally { await f.close(); }
});

test("shared binder hydrates nested DTOs/arrays, strips unknown fields and retains protobuf bytes/bigint", () => {
  try { new GrpcRequestBinding(MessageModel, modelValidatorAdapter).bind({}); throw new Error("Invalid input succeeded"); }
  catch (error) {
    expect(error).toBeInstanceOf(GrpcError);
    expect(details(error as GrpcError).errors.map((item: { code: string }) => item.code)).toContain("required");
  }
  class Nested { @Validator({ required: true, email: true }) email!: string; }
  class Request {
    @Validator({ nested: true, required: true }) nested!: Nested;
    @Validator({ nested: true }) items!: Nested[];
    bytes!: Buffer;
    count!: bigint;
  }
  registerRequestModelShape(Request, { nested: { model: Nested }, items: { model: Nested, array: true } });
  const binding = new GrpcRequestBinding(Request, modelValidatorAdapter);
  const source = { nested: { email: valid.text, ignored: true }, items: [{ email: valid.text }], bytes: Buffer.from([0, 255]), count: 9007199254740993n, ignored: "no" };
  const result = binding.bind(source) as Request;
  expect(result.nested).toBeInstanceOf(Nested);
  expect(result.items[0]).toBeInstanceOf(Nested);
  expect(result.bytes).toEqual(source.bytes);
  expect(result.bytes).not.toBe(source.bytes);
  expect(result.count).toBe(source.count);
  expect("ignored" in result).toBe(false);
  expect("ignored" in result.nested).toBe(false);
  expect(() => bindModel(Request, source, modelValidatorAdapter)).toThrow(); // HTTP still rejects binary
  for (const input of [null, [], { ...source, nested: null }, { ...source, items: [{ email: "bad" }] }]) {
    try { binding.bind(input); throw new Error("Invalid input succeeded"); }
    catch (error) { expect(error).toBeInstanceOf(GrpcError); expect((error as GrpcError).code).toBe(GrpcStatus.INVALID_ARGUMENT); }
  }
});

test("validation trailers remain bounded; generated stream mismatch and invalid options fail before listening", async () => {
  const binding = new GrpcRequestBinding(MessageModel, { validate: () => ({ isValid: false,
    errors: Array.from({ length: 100 }, () => ({ property: "count", message: "Ошибка".repeat(300), code: "limit" })),
  }) });
  try { binding.bind(valid); throw new Error("Invalid input succeeded"); }
  catch (error) {
    expect(error).toBeInstanceOf(GrpcError);
    const metadata = (error as GrpcError).metadata!.get("bazis-validation-errors-bin")[0] as Buffer;
    expect(metadata.length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(metadata.toString()).truncated).toBe(true);
  }
  @GrpcController({ Echo: echoService.Echo! })
  class GeneratedController { @GrpcMethod("Echo") echo(input: EchoMessage) { return input; } }
  registerGeneratedProviderAttachments([{ channel: GRPC_REQUEST_BINDINGS, target: GeneratedController,
    value: { echo: { model: MessageModel, requestStream: true } },
  }]);
  const container = createContainer(grpcModule({ controllers: [GeneratedController] }));
  expect(() => container.resolveAll(HOSTED_SERVICE)).toThrow("stream/DTO mismatch");
  const invalid = createContainer(grpcModule({ validator: null as never }));
  expect(() => invalid.resolveAll(HOSTED_SERVICE)).toThrow("ModelValidator");
  expect(() => GrpcMethod("Echo", null as never)).toThrow("DTO class");
  await Promise.all([container.dispose(), invalid.dispose()]);
});
