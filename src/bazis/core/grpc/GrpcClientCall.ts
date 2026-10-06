import { constants, type Http2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import type { GrpcResponseStream } from "./clientContracts";
import { GrpcError } from "./GrpcError";
import { GrpcStatus } from "./GrpcStatus";
import { Metadata } from "./Metadata";
import type { MethodDefinition } from "./serviceDefinition";

interface CallSettings {
  readonly deadline: number;
  readonly signal?: AbortSignal;
  readonly sendLimit: number;
  readonly receiveLimit: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Metadata is optional to observe; ignoring it must not cause an unhandled rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** @internal One RPC; bounded framing, pull-based download and cancellation ownership. */
export class GrpcClientCall<T> implements GrpcResponseStream<T> {
  private readonly initial = deferred<Metadata>();
  private readonly terminal = deferred<Metadata>();
  readonly metadata = this.initial.promise;
  readonly trailers = this.terminal.promise;
  private readonly abort = new AbortController();
  private readonly uploadAbort = new AbortController();
  private headers?: IncomingHttpHeaders;
  private terminalHeaders?: IncomingHttpHeaders;
  private timer?: ReturnType<typeof setTimeout>;
  private input?: AsyncIterator<unknown> | Iterator<unknown>;
  private consumed = false;
  private finished = false;
  private failure?: GrpcError;
  private readonly session?: Http2Session;
  private readonly externalCancel = (): void => this.cancel();

  constructor(
    private readonly stream: ClientHttp2Stream,
    private readonly method: MethodDefinition,
    private readonly settings: CallSettings,
    private readonly onFinish: () => void,
  ) {
    this.session = stream.session;
    stream.on("response", (headers: IncomingHttpHeaders, flags: number) => {
      if (this.finished) return;
      this.headers = headers;
      try {
        this.initial.resolve(Metadata.fromHttp2Headers(headers));
        if (flags & constants.NGHTTP2_FLAG_END_STREAM) this.receiveTrailers(headers);
        else if (headers["grpc-status"] !== undefined) throw new GrpcError(GrpcStatus.INTERNAL, "Non-terminal grpc-status.");
      } catch (error) { this.fail(protocolError(error)); }
    });
    stream.on("trailers", (headers: IncomingHttpHeaders) => this.receiveTrailers(headers));
    stream.on("error", (error: Error) => {
      // A remote status has priority over a subsequent transport reset.
      if (!this.terminalHeaders) this.fail(this.networkError(error));
    });
    stream.on("close", () => {
      if (!this.finished && !this.terminalHeaders && !stream.readableEnded) {
        this.fail(stream.rstCode || !this.headers ? this.networkError() : this.missingStatus());
      }
    });
  }

  start(requests: Iterable<unknown> | AsyncIterable<unknown>): void {
    this.settings.signal?.addEventListener("abort", this.externalCancel, { once: true });
    if (this.settings.signal?.aborted) { this.cancel(); return; }
    const remaining = this.settings.deadline - Date.now();
    if (remaining <= 0) { this.expire(); return; }
    this.timer = setTimeout(() => this.expire(), remaining);
    void this.send(requests).catch((error: unknown) => {
      if (!this.uploadAbort.signal.aborted) this.fail(error instanceof GrpcError ? error
        : new GrpcError(GrpcStatus.INVALID_ARGUMENT, "Failed to read or encode gRPC request."));
    });
  }

  cancel(): void { this.fail(new GrpcError(GrpcStatus.CANCELLED, "RPC cancelled.")); }
  connectionClosed(): void {
    if (!this.terminalHeaders) this.fail(new GrpcError(GrpcStatus.UNAVAILABLE, "gRPC connection closed before completion."));
  }
  fail(error: GrpcError): void {
    if (this.finished) return;
    this.failure = error;
    this.abort.abort(error);
    this.initial.reject(error); this.terminal.reject(error);
    this.finish(false);
  }
  private expire(): void { this.fail(new GrpcError(GrpcStatus.DEADLINE_EXCEEDED, "Deadline exceeded.")); }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new TypeError("gRPC response stream can only be consumed once.");
    this.consumed = true;
    const reader = this.read();
    // return() before the first next() must also cancel (generator finally would not run).
    return {
      next: () => reader.next(),
      return: async () => { this.cancel(); return reader.return(undefined); },
      throw: async (error) => { this.cancel(); return reader.throw(error); },
    };
  }

  private async send(requests: Iterable<unknown> | AsyncIterable<unknown>): Promise<void> {
    const stream = this.stream;
    const asyncSource = requests as AsyncIterable<unknown>;
    this.input = typeof asyncSource[Symbol.asyncIterator] === "function"
      ? asyncSource[Symbol.asyncIterator]() : (requests as Iterable<unknown>)[Symbol.iterator]();
    while (!this.uploadAbort.signal.aborted) {
      const next = await abortable(Promise.resolve(this.input.next()), this.uploadAbort.signal);
      if (next.done) { this.input = undefined; break; }
      this.uploadAbort.signal.throwIfAborted();
      const body = this.method.requestSerialize(next.value);
      if (!Buffer.isBuffer(body)) throw new TypeError("gRPC codecs must return Buffer.");
      if (body.length > this.settings.sendLimit) throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "gRPC request message is too large.");
      const frame = Buffer.allocUnsafe(body.length + 5);
      frame[0] = 0; frame.writeUInt32BE(body.length, 1); body.copy(frame, 5);
      await abortable(new Promise<void>((resolve, reject) => {
        stream.write(frame, (error?: Error | null) => error ? reject(this.networkError()) : resolve());
      }), this.uploadAbort.signal);
    }
    if (!stream.writableEnded && !stream.destroyed) stream.end();
  }

  private receiveTrailers(headers: IncomingHttpHeaders): void {
    if (this.finished) return;
    if (this.terminalHeaders) { this.fail(new GrpcError(GrpcStatus.INTERNAL, "Duplicate gRPC trailers.")); return; }
    this.terminalHeaders = headers;
    this.stopUpload();
    // Servers may finish before consuming the request stream.
    if (!this.stream.writableEnded && !this.stream.destroyed) this.stream.end();
  }

  private async *read(): AsyncGenerator<T> {
    const iterator = this.stream.iterator({ destroyOnReturn: false });
    const prefix = Buffer.alloc(5);
    let prefixBytes = 0, message: Buffer | undefined, messageBytes = 0, count = 0, discarded = 0;
    try {
      while (true) {
        this.abort.signal.throwIfAborted();
        const next = await abortable(iterator.next(), this.abort.signal);
        if (next.done) break;
        const chunk = next.value as Buffer;
        if (!this.validContentType() || Number(this.headers?.[":status"]) !== 200) {
          discarded += chunk.length;
          if (discarded > this.settings.receiveLimit) throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "Non-gRPC response is too large.");
          continue;
        }
        let offset = 0;
        while (offset < chunk.length) {
          this.abort.signal.throwIfAborted();
          if (!message) {
            const amount = Math.min(5 - prefixBytes, chunk.length - offset);
            chunk.copy(prefix, prefixBytes, offset, offset + amount);
            prefixBytes += amount; offset += amount;
            if (prefixBytes !== 5) continue;
            if (prefix[0] !== 0) throw new GrpcError(prefix[0] === 1 ? GrpcStatus.UNIMPLEMENTED : GrpcStatus.INTERNAL,
              prefix[0] === 1 ? "Compressed gRPC messages are not supported." : "Invalid gRPC compression flag.");
            const length = prefix.readUInt32BE(1);
            if (length > this.settings.receiveLimit) throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "gRPC response message is too large.");
            message = Buffer.alloc(length); messageBytes = 0;
          }
          const amount = Math.min(message.length - messageBytes, chunk.length - offset);
          chunk.copy(message, messageBytes, offset, offset + amount);
          messageBytes += amount; offset += amount;
          if (messageBytes === message.length) {
            if (++count > 1 && !this.method.responseStream) throw new GrpcError(GrpcStatus.INTERNAL, "Unary response requires exactly one message.");
            let value: T;
            try { value = this.method.responseDeserialize(message) as T; }
            catch { throw new GrpcError(GrpcStatus.INTERNAL, "Invalid protobuf response."); }
            message = undefined; prefixBytes = 0;
            yield value;
          }
        }
      }
      this.abort.signal.throwIfAborted();
      const trailers = this.checkStatus();
      if (message || prefixBytes !== 0) throw new GrpcError(GrpcStatus.INTERNAL, "Incomplete gRPC message.");
      if (!this.method.responseStream && count !== 1) throw new GrpcError(GrpcStatus.INTERNAL, "Unary response requires exactly one message.");
      this.terminal.resolve(trailers);
      this.finish(true);
    } catch (error) {
      let failure = this.failure;
      if (!failure) {
        try { if (this.terminalHeaders) this.checkStatus(); }
        catch (statusError) { failure = protocolError(statusError); }
      }
      failure ??= error instanceof GrpcError ? error : this.networkError();
      this.fail(failure);
      throw failure;
    } finally {
      if (!this.finished) this.cancel();
      void iterator.return?.().catch(() => {});
    }
  }

  private checkStatus(): Metadata {
    if (!this.terminalHeaders && this.stream.rstCode) throw this.networkError();
    if (!this.headers) throw this.networkError();
    if (!this.terminalHeaders || this.terminalHeaders["grpc-status"] === undefined) throw this.missingStatus();
    const raw = this.terminalHeaders["grpc-status"];
    if (typeof raw !== "string" || !/^(?:[0-9]|1[0-6])$/.test(raw)) throw new GrpcError(GrpcStatus.UNKNOWN, "Invalid grpc-status.");
    const metadata = Metadata.fromHttp2Headers(this.terminalHeaders);
    const code = Number(raw);
    if (code !== GrpcStatus.OK) {
      const value = this.terminalHeaders["grpc-message"];
      let message = typeof value === "string" ? value : "RPC failed.";
      try { message = decodeURIComponent(message); } catch { /* Preserve malformed remote text, never hide status. */ }
      throw new GrpcError(code, message, metadata);
    }
    if (Number(this.headers?.[":status"]) !== 200 || !this.validContentType()) throw new GrpcError(GrpcStatus.INTERNAL, "Invalid gRPC response headers.");
    return metadata;
  }
  private validContentType(): boolean {
    const value = this.headers?.["content-type"];
    return typeof value === "string" && /^application\/grpc(?:\+proto)?(?:;.*)?$/i.test(value);
  }
  private missingStatus(): GrpcError {
    const http = Number(this.headers?.[":status"]);
    const code = http === 400 ? GrpcStatus.INTERNAL : http === 401 ? GrpcStatus.UNAUTHENTICATED
      : http === 403 ? GrpcStatus.PERMISSION_DENIED : http === 404 ? GrpcStatus.UNIMPLEMENTED
      : [429, 502, 503, 504].includes(http) ? GrpcStatus.UNAVAILABLE : GrpcStatus.UNKNOWN;
    return new GrpcError(code, "Response ended without grpc-status.");
  }
  private networkError(cause?: Error): GrpcError {
    // Local connection setup failures may surface as INTERNAL_ERROR on the stream.
    const transportFailure = this.session?.destroyed || this.session?.closed
      || cause && (cause as NodeJS.ErrnoException).code !== "ERR_HTTP2_STREAM_ERROR";
    const reset = this.stream.id === undefined || transportFailure ? undefined : this.stream.rstCode;
    const code = reset === constants.NGHTTP2_CANCEL ? GrpcStatus.CANCELLED
      : reset === constants.NGHTTP2_ENHANCE_YOUR_CALM ? GrpcStatus.RESOURCE_EXHAUSTED
      : reset === constants.NGHTTP2_INADEQUATE_SECURITY ? GrpcStatus.PERMISSION_DENIED
      : reset && reset !== constants.NGHTTP2_REFUSED_STREAM ? GrpcStatus.INTERNAL : GrpcStatus.UNAVAILABLE;
    return new GrpcError(code, "gRPC connection closed before completion.");
  }
  private stopUpload(): void {
    if (this.uploadAbort.signal.aborted) return;
    this.uploadAbort.abort(new GrpcError(GrpcStatus.CANCELLED, "Request upload stopped."));
    const input = this.input; this.input = undefined;
    try { void Promise.resolve(input?.return?.()).catch(() => {}); } catch { /* Best-effort user cleanup. */ }
  }
  private finish(success: boolean): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.settings.signal?.removeEventListener("abort", this.externalCancel);
    this.stopUpload();
    try {
      if (!this.stream.closed && !this.stream.destroyed) this.stream.close(success ? constants.NGHTTP2_NO_ERROR : constants.NGHTTP2_CANCEL);
    } finally { this.onFinish(); }
  }
}

function protocolError(error: unknown): GrpcError {
  return error instanceof GrpcError ? error : new GrpcError(GrpcStatus.INTERNAL, "Invalid gRPC response metadata.");
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(signal.reason);
    if (signal.aborted) { void pending.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
