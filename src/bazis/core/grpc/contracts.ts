import type { Metadata } from "./Metadata";
import type { ServerCredentials } from "./ServerCredentials";
import type { ServerOptions, ServiceDefinition } from "./serviceDefinition";
import type { Class, BazisModuleRef } from "../di";
import type { ModelValidator } from "../http/Binding/modelValidator";
import type { RequestModelClass } from "../http/Binding/requestModelRegistry";
import type { AuthorizeContext } from "../http/Authorization/metadata";

/** Transport facts of one RPC, before its DI scope exists. */
export interface GrpcCallInfo {
  readonly metadata: Metadata;
  readonly signal: AbortSignal;
  readonly deadline: Date | number;
  readonly peer: string;
  readonly path: string;
  sendMetadata(metadata: Metadata): void;
}

/**
 * One instance per RPC, including the complete lifetime of a streaming RPC.
 * It is also what `@Authorize` checks see: `header(name)` reads text metadata,
 * `services` is the RPC scope, `state` is shared with the handler.
 */
export interface GrpcContext extends GrpcCallInfo, AuthorizeContext {}

export interface GrpcModuleOptions {
  /** Modules whose `grpcControllers` are served (the whole tree). */
  readonly imports?: readonly BazisModuleRef[];
  /** DTO validation, captured per server. Default: Bazis's modelValidatorAdapter. */
  readonly validator?: ModelValidator;
  /** host:port or [IPv6]:port, default 127.0.0.1:50051. Port 0 selects a free port. */
  readonly address?: string;
  /** Default: plaintext. Pass ServerCredentials.createSsl(...) for TLS/mTLS. */
  readonly credentials?: ServerCredentials;
  /** Bazis transport limits; unknown options fail at startup. */
  readonly serverOptions?: ServerOptions;
  /** Includes handlers still running after client cancellation. Default 1024. */
  readonly maxConcurrentCalls?: number;
  /** Grace period before forced transport shutdown. Default 5000 ms. */
  readonly shutdownTimeoutMs?: number;
  /** Hosted service startup phase, default 10 (after infrastructure). */
  readonly phase?: number;
}

export interface GrpcControllerDefinition {
  readonly controller: Class<object>;
  readonly service: ServiceDefinition;
  /** Service method key -> instance method name. */
  readonly methods: ReadonlyMap<string, string | symbol>;
  /** Explicit DTO overrides keyed by instance method; optional for compatibility. */
  readonly requestModels?: ReadonlyMap<string | symbol, RequestModelClass>;
}
