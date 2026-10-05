import type { IncomingHttpHeaders, ServerHttp2Stream } from "node:http2";
import type { GrpcContext } from "./contracts";
import { Metadata } from "./Metadata";
import { GrpcError } from "./GrpcError";
import { GrpcStatus } from "./GrpcStatus";
import type { MethodDefinition } from "./serviceDefinition";

/** Owns the standard five-byte gRPC envelope and one built-in HTTP/2 stream. */
export class GrpcTransport {
  readonly context: GrpcContext;
  private readonly abort = new AbortController();
  private sentHeaders = false;
  private ended = false;
  private consumed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private trailers: import("node:http2").OutgoingHttpHeaders = {};

  constructor(
    private readonly stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders,
    private readonly method: MethodDefinition,
    private readonly receiveLimit: number,
    private readonly sendLimit: number,
  ) {
    const deadline = parseDeadline(headers["grpc-timeout"]);
    this.context = Object.freeze({
      metadata: Metadata.fromHttp2Headers(headers),
      signal: this.abort.signal,
      deadline,
      path: method.path,
      peer: stream.session?.socket.remoteAddress ?? "",
      sendMetadata: (metadata: Metadata) => this.sendMetadata(metadata),
    });
    stream.on("error", () => this.disconnected());
    stream.on("aborted", () => this.disconnected());
    stream.on("close", () => { this.clearTimer(); if (!this.ended) this.disconnected(); });
    stream.on("wantTrailers", () => {
      if (!stream.destroyed && !stream.closed) {
        try { stream.sendTrailers(this.trailers); } catch { this.disconnected(); }
      }
    });
    if (deadline !== Infinity) this.armDeadline(deadline);
  }

  cancel(code = GrpcStatus.CANCELLED, message = "RPC cancelled."): void {
    const error = new GrpcError(code, message);
    this.abort.abort(error);
    this.fail(error);
  }
  private disconnected(): void {
    this.clearTimer();
    this.abort.abort(new GrpcError(GrpcStatus.CANCELLED, "RPC cancelled."));
    this.ended = true;
  }
  private armDeadline(deadline: number): void {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new GrpcError(GrpcStatus.DEADLINE_EXCEEDED, "Deadline exceeded.");
      this.abort.abort(error); this.fail(error);
    } else this.timer = setTimeout(() => this.armDeadline(deadline), Math.min(remaining, 2_147_483_647));
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  async unaryRequest(): Promise<unknown> {
    let value: unknown, count = 0;
    for await (const request of this.requests()) {
      if (++count > 1) throw new GrpcError(GrpcStatus.INTERNAL, "Unary RPC requires exactly one message.");
      value = request;
    }
    if (count !== 1) throw new GrpcError(GrpcStatus.INTERNAL, "Unary RPC requires exactly one message.");
    return value;
  }

  async *requests(): AsyncGenerator<unknown> {
    if (this.consumed) throw new Error("gRPC request stream can only be consumed once.");
    this.consumed = true;
    const iterator = this.stream.iterator({ destroyOnReturn: false });
    const prefix = Buffer.alloc(5);
    let prefixBytes = 0, message: Buffer | undefined, messageBytes = 0;
    try {
      while (true) {
        const next = await abortable(iterator.next(), this.abort.signal);
        if (next.done) break;
        const chunk = next.value as Buffer;
        let offset = 0;
        while (offset < chunk.length) {
          this.abort.signal.throwIfAborted();
          if (!message) {
            const amount = Math.min(5 - prefixBytes, chunk.length - offset);
            chunk.copy(prefix, prefixBytes, offset, offset + amount);
            offset += amount; prefixBytes += amount;
            if (prefixBytes !== 5) continue;
            if (prefix[0] !== 0) {
              throw new GrpcError(prefix[0] === 1 ? GrpcStatus.UNIMPLEMENTED : GrpcStatus.INTERNAL,
                prefix[0] === 1 ? "Compressed gRPC messages are not supported." : "Invalid gRPC compression flag.");
            }
            const length = prefix.readUInt32BE(1);
            if (length > this.receiveLimit) throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "gRPC request message is too large.");
            message = Buffer.alloc(length); messageBytes = 0;
          }
          const amount = Math.min(message.length - messageBytes, chunk.length - offset);
          chunk.copy(message, messageBytes, offset, offset + amount);
          offset += amount; messageBytes += amount;
          if (messageBytes === message.length) {
            let value: unknown;
            try { value = this.method.requestDeserialize(message); }
            catch { throw new GrpcError(GrpcStatus.INTERNAL, "Invalid protobuf request."); }
            message = undefined; prefixBytes = 0;
            yield value;
          }
        }
      }
      this.abort.signal.throwIfAborted();
      if (message || prefixBytes !== 0) throw new GrpcError(GrpcStatus.INTERNAL, "Incomplete gRPC message.");
    } finally {
      // return() never destroys the duplex response side. A pending read is
      // released by stream close after status/cancellation.
      void iterator.return?.().catch(() => {});
    }
  }

  sendMetadata(metadata: Metadata): void {
    if (!(metadata instanceof Metadata)) throw new TypeError("Expected Osnv Metadata.");
    if (this.sentHeaders || this.ended) throw new Error("gRPC response headers have already been sent.");
    this.stream.respond({ ...metadata.toHttp2Headers(), ":status": 200, "content-type": "application/grpc+proto", "grpc-accept-encoding": "identity" }, { waitForTrailers: true });
    this.sentHeaders = true;
  }
  async write(value: unknown): Promise<void> {
    this.abort.signal.throwIfAborted();
    if (this.ended) return;
    const body = this.method.responseSerialize(value);
    if (!Buffer.isBuffer(body)) throw new TypeError("gRPC codecs must return Buffer.");
    if (body.length > this.sendLimit) throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "gRPC response message is too large.");
    if (!this.sentHeaders) this.sendMetadata(new Metadata());
    const frame = Buffer.allocUnsafe(body.length + 5);
    frame[0] = 0; frame.writeUInt32BE(body.length, 1); body.copy(frame, 5);
    await abortable(new Promise<void>((resolve, reject) => {
      this.stream.write(frame, (error?: Error | null) => error ? reject(error) : resolve());
    }), this.abort.signal);
  }
  fail(error: unknown): void {
    const failure = error instanceof GrpcError ? error : new GrpcError(GrpcStatus.INTERNAL, "Internal server error.");
    this.finish(failure.code, failure.message, failure.metadata);
  }
  finish(code = GrpcStatus.OK, message = "", metadata = new Metadata()): void {
    if (this.ended) return;
    const trailers = { ...metadata.toHttp2Headers(), "grpc-status": String(code),
      "grpc-message": encodeURIComponent(Buffer.from(message, "utf8").toString("utf8")) };
    this.ended = true; this.clearTimer();
    this.trailers = trailers;
    if (this.stream.destroyed || this.stream.closed) return;
    try {
      if (!this.sentHeaders) {
        this.stream.respond({ ":status": 200, "content-type": "application/grpc+proto", ...this.trailers }, { endStream: true });
      } else this.stream.end();
    } catch { this.disconnected(); }
  }
}

function parseDeadline(value: string | string[] | undefined): number {
  if (value === undefined) return Infinity;
  if (typeof value !== "string" || !/^\d{1,8}[HMSmun]$/.test(value)) throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, "Invalid grpc-timeout.");
  const scale: Record<string, number> = { H: 3_600_000, M: 60_000, S: 1000, m: 1, u: 0.001, n: 0.000001 };
  return Date.now() + Math.ceil(Number(value.slice(0, -1)) * scale[value.at(-1)!]!);
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(signal.reason);
    if (signal.aborted) { void pending.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
