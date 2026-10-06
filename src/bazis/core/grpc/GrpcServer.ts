import { createServer, createSecureServer, type Http2Server, type Http2SecureServer, type ServerHttp2Session, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import type { HostedService, ModuleOwnedProviderContribution, ServiceProvider } from "../di";
import type { GrpcControllerDefinition, GrpcModuleOptions } from "./contracts";
import { ServerCredentials } from "./ServerCredentials";
import { GrpcStatus } from "./GrpcStatus";
import { GrpcCall } from "./GrpcCall";
import { GrpcTransport } from "./GrpcTransport";
import { GrpcError } from "./GrpcError";
import type { MethodDefinition } from "./serviceDefinition";
import { modelValidatorAdapter } from "../../library/validation";
import { getGrpcRequestBinding } from "./GrpcBinding.contract";
import { GrpcRequestBinding } from "./GrpcRequest.binding";

type Contribution = ModuleOwnedProviderContribution<GrpcControllerDefinition, object>;

/** Kernel-managed gRPC server built exclusively on the runtime's HTTP/2 API. */
export class GrpcServer implements HostedService {
  readonly phase: number;
  private readonly server: Http2Server | Http2SecureServer;
  private readonly hostname: string;
  private readonly listenPort: number;
  private readonly receiveLimit: number;
  private readonly sendLimit: number;
  private readonly maxConcurrentCalls: number;
  private readonly shutdownTimeoutMs: number;
  private readonly routes = new Map<string, { entry: Contribution; method: MethodDefinition; name: string | symbol; binding?: GrpcRequestBinding }>();
  private readonly sessions = new Set<ServerHttp2Session>();
  private readonly active = new Map<GrpcCall, Promise<void>>();
  private state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";
  private starting?: Promise<void>;
  private abortStart?: (error: unknown) => void;
  private stopping?: Promise<void>;
  private boundPort?: number;

  constructor(options: GrpcModuleOptions, private readonly provider: ServiceProvider, controllers: readonly Contribution[]) {
    const address = options.address ?? "127.0.0.1:50051";
    const match = typeof address === "string" && /^(?:\[([^\]]+)\]|([^:[\]\s]+)):(\d{1,5})$/.exec(address);
    if (!match || Number(match[3]) > 65535 || options.address === null) throw new TypeError("gRPC address must be host:port or [IPv6]:port.");
    this.hostname = match[1] ?? match[2]!;
    this.listenPort = Number(match[3]);
    this.phase = options.phase === undefined ? 10 : options.phase;
    if (!Number.isSafeInteger(this.phase)) throw new TypeError("gRPC phase must be a safe integer.");
    this.maxConcurrentCalls = positiveInteger(options.maxConcurrentCalls, 1024, "maxConcurrentCalls");
    this.shutdownTimeoutMs = positiveInteger(options.shutdownTimeoutMs, 5000, "shutdownTimeoutMs");
    if (this.shutdownTimeoutMs > 2_147_483_647) throw new TypeError("gRPC shutdownTimeoutMs exceeds the timer range.");
    const settings = options.serverOptions;
    if (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings))) throw new TypeError("Invalid gRPC serverOptions.");
    const allowed = new Set(["grpc.max_receive_message_length", "grpc.max_send_message_length", "grpc.max_concurrent_streams"]);
    for (const key of Object.keys(settings ?? {})) {
      if (!allowed.has(key)) throw new TypeError("Unsupported gRPC server option: " + key);
    }
    this.receiveLimit = messageLimit(settings?.["grpc.max_receive_message_length"]);
    this.sendLimit = messageLimit(settings?.["grpc.max_send_message_length"]);
    const maxStreams = positiveInteger(settings?.["grpc.max_concurrent_streams"], 1024, "max_concurrent_streams");
    if (maxStreams > 0xffffffff) throw new TypeError("gRPC max_concurrent_streams exceeds HTTP/2 range.");
    const credentials = options.credentials === undefined ? ServerCredentials.createInsecure() : options.credentials;
    if (!(credentials instanceof ServerCredentials)) throw new TypeError("gRPC credentials must be Bazis ServerCredentials.");
    const validator = options.validator === undefined ? modelValidatorAdapter : options.validator;
    if (!validator || typeof validator.validate !== "function") throw new TypeError("gRPC validator must implement ModelValidator.");
    for (const entry of controllers) {
      for (const [key, name] of entry.payload.methods) {
        const method = entry.payload.service[key]!;
        if (this.routes.has(method.path)) throw new TypeError("Duplicate gRPC method: " + method.path + ".");
        const explicit = entry.payload.requestModels?.get(name);
        const generated = getGrpcRequestBinding(entry.payload.controller, name);
        if (!explicit && generated && generated.requestStream !== method.requestStream) {
          throw new TypeError(`gRPC request stream/DTO mismatch: ${method.path}.`);
        }
        const model = explicit ?? generated?.model;
        this.routes.set(method.path, { entry, method, name, binding: model ? new GrpcRequestBinding(model, validator) : undefined });
      }
    }
    const tls = credentials.http2Options();
    const http2 = { settings: { maxConcurrentStreams: maxStreams, maxHeaderListSize: 8192 }, maxHeaderListPairs: 128 };
    this.server = tls ? createSecureServer({ ...tls, ...http2 }) : createServer(http2);
    this.server.on("error", () => {}); // start() observes bind failures; peer/session failures never crash the process.
    this.server.on("session", (session) => {
      this.sessions.add(session);
      session.on("error", () => {});
      session.once("close", () => this.sessions.delete(session));
      if (this.state === "stopping" || this.state === "stopped") session.destroy();
    });
    this.server.on("stream", (stream, headers) => this.accept(stream as ServerHttp2Stream, headers));
  }

  get port(): number | undefined { return this.boundPort; }
  get activeCalls(): number { return this.active.size; }

  private accept(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    stream.on("error", () => {});
    stream.once("finish", () => { if (!stream.readableEnded && !stream.closed) stream.close(); });
    if (!/^application\/grpc(?:\+proto)?(?:;|$)/.test(String(headers["content-type"]))) {
      stream.respond({ ":status": 415 }, { endStream: true }); return;
    }
    const reject = (code: GrpcStatus, message: string): void => {
      if (!stream.destroyed) stream.respond({
        ":status": 200, "content-type": "application/grpc+proto", "grpc-accept-encoding": "identity",
        "grpc-status": String(code), "grpc-message": encodeURIComponent(message),
      }, { endStream: true });
    };
    if (headers[":method"] !== "POST") { reject(GrpcStatus.UNIMPLEMENTED, "gRPC requires POST."); return; }
    if (this.state !== "running") { reject(GrpcStatus.UNAVAILABLE, "Server is stopping."); return; }
    const route = this.routes.get(String(headers[":path"]));
    if (!route) { reject(GrpcStatus.UNIMPLEMENTED, "Unknown gRPC method."); return; }
    if (this.active.size >= this.maxConcurrentCalls) { reject(GrpcStatus.RESOURCE_EXHAUSTED, "Too many concurrent RPCs."); return; }
    if (headers["grpc-encoding"] !== undefined && headers["grpc-encoding"] !== "identity") {
      reject(GrpcStatus.UNIMPLEMENTED, "Compressed gRPC messages are not supported."); return;
    }
    let transport: GrpcTransport;
    try { transport = new GrpcTransport(stream, headers, route.method, this.receiveLimit, this.sendLimit); }
    catch (error) {
      reject(error instanceof GrpcError ? error.code : GrpcStatus.INVALID_ARGUMENT, error instanceof GrpcError ? error.message : "Invalid gRPC headers.");
      return;
    }
    const execution = new GrpcCall(transport, route.method, route.name, route.entry.activation, this.provider, route.binding);
    const pending = execution.run().catch((error: unknown) => transport.fail(error))
      .finally(() => this.active.delete(execution));
    this.active.set(execution, pending);
  }

  start(signal?: AbortSignal): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "starting") return this.starting!;
    if (this.state !== "idle") return Promise.reject(new Error("A stopped gRPC server cannot be restarted."));
    if (signal?.aborted) { this.state = "stopped"; return Promise.reject(signal.reason); }
    this.state = "starting";
    this.starting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        signal?.removeEventListener("abort", abort);
        this.server.off("error", fail);
        this.abortStart = undefined;
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup(); this.state = "stopped"; this.forceClose(); reject(error);
      };
      const abort = (): void => fail(signal?.reason ?? new Error("gRPC startup cancelled."));
      this.abortStart = fail;
      signal?.addEventListener("abort", abort, { once: true });
      this.server.once("error", fail);
      try {
        this.server.listen(this.listenPort, this.hostname, () => {
          cleanup();
          if (this.state !== "starting") { this.forceClose(); reject(new Error("gRPC startup cancelled.")); return; }
          settled = true;
          this.boundPort = (this.server.address() as AddressInfo).port;
          this.state = "running"; resolve();
        });
      } catch (error) { fail(error); }
    });
    return this.starting;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopServer();
    return this.stopping;
  }
  private async stopServer(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") { this.state = "stopped"; return; }
    if (this.state === "starting") {
      this.abortStart?.(new Error("gRPC startup cancelled by stop."));
      await this.starting?.catch(() => {});
    }
    this.state = "stopping";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = new Promise<void>((resolve) => {
        if (!this.server.listening) { resolve(); return; }
        this.server.close(() => resolve());
      });
      for (const session of this.sessions) session.close();
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          for (const execution of this.active.keys()) execution.cancel();
          this.forceClose();
          reject(new Error("gRPC shutdown timed out; transport forced closed."));
        }, this.shutdownTimeoutMs);
      });
      await Promise.race([Promise.all([closed, ...this.active.values()]), expired]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.forceClose(); this.boundPort = undefined; this.state = "stopped";
    }
  }
  private forceClose(): void {
    for (const session of this.sessions) session.destroy();
    if (this.server.listening) this.server.close();
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError("gRPC " + name + " must be a positive safe integer.");
  return result;
}
function messageLimit(value: number | undefined): number {
  const result = value === undefined ? 4 * 1024 * 1024 : value;
  if (!Number.isInteger(result) || result < 0 || result > 0x7fffffff) throw new TypeError("gRPC message limit must be 0..2147483647 bytes.");
  return result;
}
