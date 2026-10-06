import type { Metadata } from "./Metadata";

/** TLS always verifies the server certificate; plaintext requires an http address. */
export interface GrpcClientTlsOptions {
  readonly ca?: string | Buffer;
  readonly cert?: string | Buffer;
  readonly key?: string | Buffer;
  readonly servername?: string;
}

export interface GrpcClientOptions {
  readonly address: string;
  readonly tls?: GrpcClientTlsOptions;
  readonly metadata?: Metadata;
  readonly timeoutMs?: number;
  readonly maxSendMessageLength?: number;
  readonly maxReceiveMessageLength?: number;
  readonly maxConcurrentCalls?: number;
}

export interface GrpcCallOptions {
  readonly metadata?: Metadata;
  readonly timeoutMs?: number;
  readonly deadline?: Date | number;
  readonly signal?: AbortSignal;
}

export interface GrpcResponse<T> {
  readonly data: T;
  readonly metadata: Metadata;
  readonly trailers: Metadata;
}

/** Consume once. Early for-await exit cancels the call, as does cancel(). */
export interface GrpcResponseStream<T> extends AsyncIterable<T> {
  readonly metadata: Promise<Metadata>;
  readonly trailers: Promise<Metadata>;
  cancel(): void;
}
