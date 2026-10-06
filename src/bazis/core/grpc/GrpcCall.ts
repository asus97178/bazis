import type { ModuleOwnedProviderActivation, ServiceProvider } from "../di";
import type { GrpcContext } from "./contracts";
import type { MethodDefinition } from "./serviceDefinition";
import { GrpcTransport } from "./GrpcTransport";
import { GrpcStatus } from "./GrpcStatus";
import type { GrpcRequestBinding } from "./GrpcRequest.binding";

/** One RPC owns its handler and DI scope, even after the peer disconnects. */
export class GrpcCall {
  constructor(
    private readonly transport: GrpcTransport,
    private readonly definition: MethodDefinition,
    private readonly methodName: string | symbol,
    private readonly activation: ModuleOwnedProviderActivation<object>,
    private readonly provider: ServiceProvider,
    private readonly binding?: GrpcRequestBinding,
  ) {}

  cancel(): void { this.transport.cancel(GrpcStatus.UNAVAILABLE, "Server stopped."); }

  async run(): Promise<void> {
    const scope = this.provider.createScope();
    const context = this.transport.context;
    let result: unknown;
    let failure: unknown;
    let failed = false;
    let inputFailure: unknown;
    let inputFailed = false;
    const bind = (value: unknown): unknown => {
      try { return this.binding?.bind(value) ?? value; }
      catch (error) { inputFailure = error; inputFailed = true; throw error; }
    };
    const requests = this.transport.requests();
    async function* validatedRequests(): AsyncIterable<unknown> {
      for await (const value of requests) yield bind(value);
    }
    try {
      context.signal.throwIfAborted();
      const input = this.definition.requestStream
        ? (this.binding ? validatedRequests() : requests)
        : bind(await this.transport.unaryRequest());
      const instance = await this.activation.activateAsync(scope);
      context.signal.throwIfAborted();
      const handler = Reflect.get(instance, this.methodName) as (input: unknown, context: GrpcContext) => unknown;
      result = await handler.call(instance, input, context);
      if (inputFailed) throw inputFailure;
      if (this.definition.responseStream) {
        if (!result || typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") {
          throw new TypeError("A response-streaming gRPC handler must return AsyncIterable.");
        }
        for await (const message of result as AsyncIterable<unknown>) {
          if (inputFailed) throw inputFailure;
          context.signal.throwIfAborted();
          await this.transport.write(message);
        }
      }
      if (inputFailed) throw inputFailure;
      context.signal.throwIfAborted();
    } catch (error) {
      failure = error; failed = true;
    } finally {
      // Do not dispose dependencies while non-cooperative handler code is running.
      try { await scope.dispose(); } catch (error) { failure = error; failed = true; }
    }
    if (failed) this.transport.fail(failure);
    else {
      try {
        if (!this.definition.responseStream) await this.transport.write(result);
        this.transport.finish();
      } catch (error) { this.transport.fail(error); }
    }
  }
}
