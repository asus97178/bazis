import { connect, constants, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { EventEmitter } from "node:events";
import { Metadata } from "../../Metadata";

export interface EchoMessage { text: string; count: number }
export interface ServiceError extends Error { code: number; details: string }
export type ClientReadableStream<T> = AsyncIterable<T>;
type Callback = (error: ServiceError | null, response?: EchoMessage) => void;

/** Test-only independent wire peer, not an Bazis client API.
 * The Echo codec and envelope are independent of production code.
 */
class TestRpc extends EventEmitter implements AsyncIterable<EchoMessage> {
  private readonly request: ClientHttp2Stream;
  private readonly messages: EchoMessage[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: ServiceError;
  private status = 14;
  private details = "gRPC transport closed without status.";
  private buffer = Buffer.alloc(0);
  private timer?: ReturnType<typeof setTimeout>;

  constructor(session: ClientHttp2Session, method: string, metadata: Metadata, deadline: number, callback?: Callback) {
    super();
    this.request = session.request({
      ...metadata.toHttp2Headers(), ":method": "POST", ":path": "/bazis.test.Echo/" + method,
      "content-type": "application/grpc", te: "trailers",
      "grpc-timeout": Math.max(1, deadline - Date.now()) + "m",
    });
    const headers = (values: IncomingHttpHeaders): void => {
      if (values["grpc-status"] !== undefined) {
        this.status = Number(values["grpc-status"]);
        this.details = decodeURIComponent(String(values["grpc-message"] ?? ""));
      }
    };
    this.request.on("response", (values) => { headers(values); this.emit("metadata", Metadata.fromHttp2Headers(values)); });
    this.request.on("trailers", (values) => { headers(values); this.emit("status", values); });
    this.request.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 5 && this.buffer.length >= 5 + this.buffer.readUInt32BE(1)) {
        const length = this.buffer.readUInt32BE(1);
        this.messages.push(decodeEcho(this.buffer.subarray(5, 5 + length)));
        this.buffer = this.buffer.subarray(5 + length);
        this.wake?.();
      }
    });
    const finish = (): void => this.settle(this.status === 0 ? undefined : error(this.status, this.details));
    this.request.on("end", finish);
    this.request.on("close", finish);
    this.request.on("error", () => this.settle(error(14, "Transport unavailable.")));
    this.timer = setTimeout(() => {
      this.settle(error(4, "Deadline exceeded."));
      this.request.close(constants.NGHTTP2_CANCEL);
    }, Math.max(1, deadline - Date.now()));
    if (callback) {
      void (async () => {
        let response: EchoMessage | undefined;
        try { for await (const item of this) response = item; callback(null, response); }
        catch (failure) { callback(failure as ServiceError); }
      })();
    }
  }
  write(message: Partial<EchoMessage>): boolean {
    const body = encodeEcho(message), prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(body.length, 1);
    return this.request.write(Buffer.concat([prefix, body]));
  }
  end(): void { this.request.end(); }
  cancel(): void { this.settle(error(1, "RPC cancelled.")); this.request.close(constants.NGHTTP2_CANCEL); }
  private settle(failure?: ServiceError): void {
    if (this.ended) return;
    this.ended = true; this.failure = failure;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<EchoMessage> {
    while (true) {
      while (this.messages.length) yield this.messages.shift()!;
      if (this.ended) { if (this.failure) throw this.failure; return; }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export function echoClient(port: number) {
  const session = connect("http://127.0.0.1:" + port);
  session.on("error", () => {});
  const start = (method: string, args: any[]): TestRpc => {
    const metadata = args.find((value) => value instanceof Metadata) ?? new Metadata();
    const options = args.find((value) => value && typeof value === "object" && "deadline" in value);
    const callback = args.find((value) => typeof value === "function") as Callback | undefined;
    return new TestRpc(session, method, metadata, options?.deadline ?? Date.now() + 5000, callback);
  };
  return {
    Echo(message: Partial<EchoMessage>, ...args: any[]) { const rpc = start("Echo", args); rpc.write(message); rpc.end(); return rpc; },
    Expand(message: Partial<EchoMessage>, ...args: any[]) { const rpc = start("Expand", args); rpc.write(message); rpc.end(); return rpc; },
    Collect(...args: any[]) { return start("Collect", args); },
    Chat(...args: any[]) { return start("Chat", args); },
    close() { session.destroy(); },
  };
}

export function encodeEcho(message: Partial<EchoMessage>): Buffer {
  const parts: Buffer[] = [];
  if (message.text !== undefined) { const text = Buffer.from(message.text); parts.push(Buffer.from([10]), vint(BigInt(text.length)), text); }
  if (message.count !== undefined) parts.push(Buffer.from([16]), vint(BigInt.asUintN(64, BigInt(message.count))));
  return Buffer.concat(parts);
}
function decodeEcho(body: Buffer): EchoMessage {
  let offset = 0;
  const integer = (): bigint => {
    let result = 0n, shift = 0n;
    while (offset < body.length && shift < 70n) {
      const value = body[offset++]!;
      result |= BigInt(value & 127) << shift;
      if (value < 128) return result;
      shift += 7n;
    }
    throw new Error("Invalid fixture protobuf.");
  };
  const message = { text: "", count: 0 };
  while (offset < body.length) {
    const tag = Number(integer());
    if (tag === 10) { const size = Number(integer()); message.text = body.toString("utf8", offset, offset + size); offset += size; }
    else if (tag === 16) message.count = Number(BigInt.asIntN(32, integer()));
    else throw new Error("Unexpected fixture field.");
  }
  return message;
}
function vint(value: bigint): Buffer {
  const result: number[] = [];
  do { const next = Number(value & 127n); value >>= 7n; result.push(value ? next | 128 : next); } while (value);
  return Buffer.from(result);
}
function error(code: number, details: string): ServiceError { return Object.assign(new Error(details), { code, details }); }
