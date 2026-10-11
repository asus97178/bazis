import type { ModuleOwnedProviderActivation, ServiceProvider } from "../di";
import type { GrpcContext } from "./contracts";
import { GrpcError } from "./GrpcError";
import type { AuthorizeCheck } from "../http/Authorization/metadata";
import { ForbiddenError, UnauthorizedError } from "../http/Errors/HttpError";
import { JwtError } from "../../library/jwt/errors";
import { redactSensitive } from "../../library/redaction";
import type { Logger } from "../kernel/logging/Logger";
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
    /** `@Authorize` checks of the controller and the method, in order. */
    private readonly checks: readonly AuthorizeCheck[] = [],
    private readonly logger?: Logger,
  ) {}

  cancel(): void { this.transport.cancel(GrpcStatus.UNAVAILABLE, "Server stopped."); }

  async run(): Promise<void> {
    const scope = this.provider.createScope();
    const info = this.transport.context;
    const context: GrpcContext = Object.freeze({
      ...info,
      services: scope,
      state: new Map<string, unknown>(),
      header: (name: string) => {
        const value = info.metadata.get(name)[0];
        return typeof value === "string" ? value : undefined;
      },
    });
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
      // Like HTTP: access is decided before the request is read.
      await authorize(this.checks, context);
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
    if (failed) {
      // An intentional GrpcError and a cancelled call are not server failures;
      // anything else is a bug and belongs in the log, like an HTTP 500.
      if (!(failure instanceof GrpcError) && !context.signal.aborted) {
        this.logger?.error("gRPC handler failed", { path: this.definition.path, error: redactSensitive(failure) });
      }
      this.transport.fail(failure);
    }
    else {
      try {
        if (!this.definition.responseStream) await this.transport.write(result);
        this.transport.finish();
      } catch (error) { this.transport.fail(error); }
    }
  }
}

/**
 * Runs the `@Authorize` checks: `false` and `ForbiddenError` are
 * PERMISSION_DENIED, `UnauthorizedError` and `JwtError` (missing, malformed,
 * expired token) are UNAUTHENTICATED. Any other error propagates as a bug.
 */
async function authorize(checks: readonly AuthorizeCheck[], context: GrpcContext): Promise<void> {
  for (const check of checks) {
    let allowed: boolean;
    try {
      allowed = await check(context);
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof JwtError) {
        throw new GrpcError(GrpcStatus.UNAUTHENTICATED, "Unauthenticated.");
      }
      if (error instanceof ForbiddenError) throw new GrpcError(GrpcStatus.PERMISSION_DENIED, "Permission denied.");
      throw error;
    }
    if (!allowed) throw new GrpcError(GrpcStatus.PERMISSION_DENIED, "Permission denied.");
  }
}
