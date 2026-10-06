import type { Metadata } from "./Metadata";
import type { ServerCredentials } from "./ServerCredentials";
import type { ServerOptions, ServiceDefinition } from "./serviceDefinition";
import type { Class, BazisModuleRef } from "../di";
import type { ModelValidator } from "../http/Binding/modelValidator";
import type { RequestModelClass } from "../http/Binding/requestModelRegistry";

/** One instance per RPC, including the complete lifetime of a streaming RPC. */
export interface GrpcContext {
  readonly metadata: Metadata;
  readonly signal: AbortSignal;
  readonly deadline: Date | number;
  readonly peer: string;
  readonly path: string;
  sendMetadata(metadata: Metadata): void;
}

export interface GrpcModuleOptions {
  readonly imports?: readonly BazisModuleRef[];
  /** Normally contributed by feature-module grpcControllers. */
  readonly controllers?: readonly Class<object>[];
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
