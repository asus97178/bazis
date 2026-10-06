import { connect, type ClientHttp2Session, type SecureClientSessionOptions } from "node:http2";
import type { GrpcCallOptions, GrpcClientOptions, GrpcResponse, GrpcResponseStream } from "./clientContracts";
import { GrpcClientCall } from "./GrpcClientCall";
import { GrpcError } from "./GrpcError";
import { GrpcStatus } from "./GrpcStatus";
import { Metadata } from "./Metadata";
import type { MethodDefinition, ServiceDefinition } from "./serviceDefinition";

/** Standard gRPC/HTTP2 client using only built-in networking and Bazis codecs. */
export class GrpcClient {
  private readonly methods = new Map<string, MethodDefinition | null>();
  private readonly sessions = new Map<ClientHttp2Session, Set<GrpcClientCall<unknown>>>();
  private readonly calls = new Set<GrpcClientCall<unknown>>();
  private readonly address: string;
  private readonly tls: SecureClientSessionOptions;
  private readonly metadata: Metadata;
  private readonly timeout: number;
  private readonly sendLimit: number;
  private readonly receiveLimit: number;
  private readonly callLimit: number;
  private current?: ClientHttp2Session;
  private closed = false;

  constructor(service: ServiceDefinition, options: GrpcClientOptions) {
    fields(options, ["address", "tls", "metadata", "timeoutMs", "maxSendMessageLength", "maxReceiveMessageLength", "maxConcurrentCalls"], "GrpcClientOptions");
    if (typeof options.address !== "string" || options.address.trim() !== options.address || !options.address) throw new TypeError("gRPC address is required.");
    const hasScheme = options.address.includes("://");
    if (!hasScheme && !/^(?:\[[^\]]+\]|[^:/?#@\s]+):\d+$/.test(options.address)) throw new TypeError("gRPC address must be host:port or an HTTP(S) origin.");
    const url = new URL(hasScheme ? options.address : `http://${options.address}`);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || url.port === "0") throw new TypeError("Invalid gRPC address.");
    this.address = url.origin;
    this.tls = { rejectUnauthorized: true, settings: { enablePush: false, maxHeaderListSize: 8192 }, maxHeaderListPairs: 128 };
    if (options.tls !== undefined) {
      fields(options.tls, ["ca", "cert", "key", "servername"], "GrpcClientTlsOptions");
      if (url.protocol !== "https:") throw new TypeError("gRPC TLS options require an https address.");
      for (const key of ["ca", "cert", "key"] as const) {
        const value = options.tls[key];
        if (value !== undefined) {
          if (!(typeof value === "string" && value.length > 0) && !(Buffer.isBuffer(value) && value.length > 0)) throw new TypeError(`Invalid TLS ${key}.`);
          this.tls[key] = Buffer.isBuffer(value) ? Buffer.from(value) : value;
        }
      }
      if ((options.tls.cert === undefined) !== (options.tls.key === undefined)) throw new TypeError("TLS cert and key must be provided together.");
      if (options.tls.servername !== undefined) {
        if (typeof options.tls.servername !== "string" || !options.tls.servername.trim()) throw new TypeError("Invalid TLS servername.");
        this.tls.servername = options.tls.servername;
      }
    }
    this.metadata = metadataCopy(options.metadata);
    this.timeout = integer(options.timeoutMs, 30_000, 1, 2_147_483_647, "timeoutMs");
    this.sendLimit = integer(options.maxSendMessageLength, 4 * 1024 * 1024, 0, 2_147_483_647, "maxSendMessageLength");
    this.receiveLimit = integer(options.maxReceiveMessageLength, 4 * 1024 * 1024, 0, 2_147_483_647, "maxReceiveMessageLength");
    this.callLimit = integer(options.maxConcurrentCalls, 1024, 1, Number.MAX_SAFE_INTEGER, "maxConcurrentCalls");
    if (!service || typeof service !== "object" || !Object.keys(service).length) throw new TypeError("GrpcClient requires a non-empty service definition.");
    const paths = new Set<string>();
    for (const [key, value] of Object.entries(service)) {
      if (!value || typeof value.path !== "string" || !/^\/[^/\s?#]+\/[^/\s?#]+$/.test(value.path)
        || typeof value.requestStream !== "boolean" || typeof value.responseStream !== "boolean"
        || typeof value.requestSerialize !== "function" || typeof value.responseDeserialize !== "function"
        || value.originalName !== undefined && typeof value.originalName !== "string"
        || paths.has(value.path)) throw new TypeError(`Invalid gRPC client method: ${key}.`);
      paths.add(value.path);
      const method = Object.freeze({ ...value });
      for (const alias of new Set([key, value.originalName, value.path.split("/").at(-1)])) {
        if (alias) this.methods.set(alias, this.methods.has(alias) ? null : method);
      }
    }
  }

  get activeCalls(): number { return this.calls.size; }

  async unary<Request, Response>(method: string, request: Request, options?: GrpcCallOptions): Promise<GrpcResponse<Response>> {
    return this.single(this.open<Response>(method, [request], false, false, options));
  }
  serverStream<Request, Response>(method: string, request: Request, options?: GrpcCallOptions): GrpcResponseStream<Response> {
    return this.open<Response>(method, [request], false, true, options);
  }
  async clientStream<Request, Response>(method: string, requests: Iterable<Request> | AsyncIterable<Request>, options?: GrpcCallOptions): Promise<GrpcResponse<Response>> {
    return this.single(this.open<Response>(method, requests, true, false, options));
  }
  bidi<Request, Response>(method: string, requests: Iterable<Request> | AsyncIterable<Request>, options?: GrpcCallOptions): GrpcResponseStream<Response> {
    return this.open<Response>(method, requests, true, true, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const call of this.calls) call.cancel();
    for (const session of this.sessions.keys()) session.destroy();
    this.sessions.clear(); this.current = undefined;
  }
  dispose(): void { this.close(); }

  private async single<T>(call: GrpcClientCall<T>): Promise<GrpcResponse<T>> {
    let data!: T;
    for await (const value of call) data = value;
    return { data, metadata: await call.metadata, trailers: await call.trailers };
  }

  private open<T>(name: string, requests: Iterable<unknown> | AsyncIterable<unknown>, requestStream: boolean, responseStream: boolean, options: GrpcCallOptions = {}): GrpcClientCall<T> {
    const method = this.methods.get(name);
    if (!method) throw new TypeError(`Unknown or ambiguous gRPC method: ${name}.`);
    if (method.requestStream !== requestStream || method.responseStream !== responseStream) throw new TypeError(`Wrong gRPC call mode: ${name}.`);
    if (!requests || typeof (requests as Iterable<unknown>)[Symbol.iterator] !== "function"
      && typeof (requests as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") throw new TypeError("Streaming requests must be Iterable or AsyncIterable.");
    fields(options, ["metadata", "timeoutMs", "deadline", "signal"], "GrpcCallOptions");
    const metadata = this.metadata.clone(); metadata.merge(metadataCopy(options.metadata));
    const timeout = integer(options.timeoutMs, this.timeout, 1, 2_147_483_647, "timeoutMs");
    let deadline = Date.now() + timeout;
    if (options.deadline !== undefined) {
      const explicit = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline;
      if (typeof explicit !== "number" || !Number.isFinite(explicit)) throw new TypeError("Invalid gRPC deadline.");
      deadline = Math.min(deadline, explicit);
    }
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError("Invalid gRPC signal.");
    if (options.signal?.aborted) throw new GrpcError(GrpcStatus.CANCELLED, "RPC cancelled.");
    if (deadline <= Date.now()) throw new GrpcError(GrpcStatus.DEADLINE_EXCEEDED, "Deadline exceeded.");
    if (this.closed) throw new GrpcError(GrpcStatus.CANCELLED, "gRPC client is closed.");
    if (this.calls.size >= this.callLimit) throw new GrpcError(GrpcStatus.RESOURCE_EXHAUSTED, "Too many concurrent gRPC calls.");
    let session: ClientHttp2Session, stream: ReturnType<ClientHttp2Session["request"]>;
    try {
      session = this.session();
      const remaining = Math.max(1, Math.ceil(deadline - Date.now()));
      const wireTimeout = remaining <= 99_999_999 ? `${remaining}m` : `${Math.ceil(remaining / 1000)}S`;
      stream = session.request({ ...metadata.toHttp2Headers(), ":method": "POST", ":path": method.path,
        "content-type": "application/grpc+proto", te: "trailers", "grpc-accept-encoding": "identity", "grpc-timeout": wireTimeout }, { endStream: false });
    } catch { throw new GrpcError(GrpcStatus.UNAVAILABLE, "Unable to open gRPC connection."); }
    const call = new GrpcClientCall<T>(stream, method, { deadline, signal: options.signal, sendLimit: this.sendLimit, receiveLimit: this.receiveLimit }, () => {
      this.calls.delete(call);
      this.sessions.get(session)?.delete(call);
      if (session.connecting && !this.sessions.get(session)?.size) session.destroy();
    });
    this.calls.add(call); this.sessions.get(session)!.add(call);
    call.start(requests);
    return call;
  }

  private session(): ClientHttp2Session {
    if (this.current && !this.current.closed && !this.current.destroyed) return this.current;
    const session = connect(this.address, this.tls);
    this.current = session;
    const calls = new Set<GrpcClientCall<unknown>>();
    this.sessions.set(session, calls);
    const disconnected = (): void => {
      if (this.current === session) this.current = undefined;
      for (const call of calls) call.connectionClosed();
    };
    session.on("error", disconnected);
    session.on("close", () => { disconnected(); this.sessions.delete(session); });
    session.on("goaway", () => {
      if (this.current === session) this.current = undefined;
      session.close();
    });
    return session;
  }
}

function fields(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} option: ${key}.`);
}
function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid gRPC ${label}.`);
  return value;
}
function metadataCopy(value: Metadata | undefined): Metadata {
  if (value === undefined) return new Metadata();
  if (!(value instanceof Metadata)) throw new TypeError("Expected Bazis Metadata.");
  return value.clone();
}
