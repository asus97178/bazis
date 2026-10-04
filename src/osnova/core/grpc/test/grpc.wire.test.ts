import { expect, test } from "bun:test";
import { connect, type OutgoingHttpHeaders, type IncomingHttpHeaders } from "node:http2";
import { Module, createContainer, HOSTED_SERVICE } from "../../di";
import { GrpcController, GrpcMethod, GrpcServer, grpcModule, Metadata, GrpcError, GrpcStatus, type GrpcContext, type GrpcModuleOptions } from "../index";
import { echoService } from "./fixtures/contract";
import { encodeEcho, type EchoMessage } from "./fixtures/nativeClient";

async function serverFor(
  handler: (request: EchoMessage, context: GrpcContext) => unknown = (request) => request,
  options: GrpcModuleOptions = {},
) {
  @GrpcController({Echo: echoService.Echo!})
  class Controller { @GrpcMethod("Echo") echo(request: EchoMessage, context: GrpcContext) { return handler(request, context); } }
  @Module({grpcControllers:[Controller], exports:[]}) class Feature {}
  const container = createContainer(grpcModule({imports:[Feature], address:"127.0.0.1:0", ...options}));
  const server = container.resolveAll(HOSTED_SERVICE)[0] as GrpcServer;
  await server.start();
  return {server, async close() { await server.stop(); await container.dispose(); }};
}
function frame(body: Buffer): Buffer {
  const prefix = Buffer.alloc(5); prefix.writeUInt32BE(body.length,1);
  return Buffer.concat([prefix,body]);
}
async function exchange(port: number, chunks: readonly Buffer[], headers: OutgoingHttpHeaders = {}, openUpload = false, fragmented = false) {
  const session = connect("http://127.0.0.1:" + port);
  session.on("error", () => {});
  try {
    return await new Promise<{headers:IncomingHttpHeaders; trailers:IncomingHttpHeaders; body:Buffer}>((resolve,reject) => {
      const request = session.request({":method":"POST",":path":"/osnova.test.Echo/Echo","content-type":"application/grpc",te:"trailers",...headers});
      let initial:IncomingHttpHeaders = {}, trailers:IncomingHttpHeaders = {};
      const data:Buffer[] = [];
      const timer = setTimeout(() => { reject(new Error("Wire test timed out.")); request.close(); }, 2000);
      request.on("response", (headers) => { initial = headers; });
      request.on("trailers", (headers) => { trailers = headers; });
      request.on("data", (chunk:Buffer) => data.push(chunk));
      request.on("error", reject);
      request.on("end", () => { clearTimeout(timer); resolve({headers:initial,trailers,body:Buffer.concat(data)}); });
      request.on("close", () => clearTimeout(timer));
      void (async () => {
        for (const chunk of chunks) {
          request.write(chunk);
          if (fragmented) await Bun.sleep(2);
        }
        if (!openUpload) request.end();
      })().catch(reject);
    });
  } finally { session.destroy(); }
}
function status(response: Awaited<ReturnType<typeof exchange>>): number {
  return Number(response.trailers["grpc-status"] ?? response.headers["grpc-status"]);
}

test("wire framing accepts fragmented envelopes and empty protobuf messages", async () => {
  const f = await serverFor();
  try {
    const message = frame(encodeEcho({text:"split",count:2}));
    const response = await exchange(f.server.port!, [...message].map((byte) => Buffer.from([byte])), {}, false, true);
    expect(status(response)).toBe(0); expect(response.body).toEqual(message);
    expect(status(await exchange(f.server.port!, [frame(Buffer.alloc(0))]))).toBe(0);
  } finally { await f.close(); }
});

test("wire validation rejects bad routes, content, framing, payload and oversized lengths", async () => {
  const f = await serverFor(undefined, {serverOptions:{"grpc.max_receive_message_length":32}});
  try {
    expect(Number((await exchange(f.server.port!, [], {"content-type":"application/json"})).headers[":status"])).toBe(415);
    expect(status(await exchange(f.server.port!, [], {":path":"/unknown/Method"}))).toBe(12);
    expect(status(await exchange(f.server.port!, [], {":method":"GET"}))).toBe(12);
    expect(status(await exchange(f.server.port!, [], {"grpc-timeout":"not-a-timeout"}))).toBe(3);
    expect(status(await exchange(f.server.port!, [], {"grpc-encoding":"gzip"}))).toBe(12);
    expect(status(await exchange(f.server.port!, [Buffer.from("00ffffffff","hex")]))).toBe(8);
    expect(status(await exchange(f.server.port!, [Buffer.from("0200000000","hex")]))).toBe(13);
    expect(status(await exchange(f.server.port!, [Buffer.from("0100000000","hex")]))).toBe(12);
    expect(status(await exchange(f.server.port!, [Buffer.from("0000000002ff","hex")]))).toBe(13);
    expect(status(await exchange(f.server.port!, [frame(Buffer.from([0]))]))).toBe(13);
    expect(status(await exchange(f.server.port!, []))).toBe(13);
    expect(status(await exchange(f.server.port!, [frame(Buffer.alloc(0)),frame(Buffer.alloc(0))]))).toBe(13);
    expect(f.server.activeCalls).toBe(0);
  } finally { await f.close(); }
});

test("server enforces deadline without a client timer and sends initial/trailing binary metadata", async () => {
  let cancelled = false;
  const f = await serverFor(async (request, context) => {
    if (request.text === "slow") {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => {cancelled=true;resolve();}, {once:true}));
      return request;
    }
    expect(context.metadata.get("input-bin")).toEqual([Buffer.from([0]),Buffer.from([255])]);
    const initial = new Metadata(); initial.set("reply-bin",Buffer.from([1,255])); context.sendMetadata(initial);
    const trailers = new Metadata(); trailers.set("error-bin",Buffer.from([42]));
    throw new GrpcError(GrpcStatus.NOT_FOUND,"Нет % записи\ud800",trailers);
  });
  try {
    const deadline = await exchange(f.server.port!, [frame(encodeEcho({text:"slow"}))], {"grpc-timeout":"50m"});
    expect(status(deadline)).toBe(4); expect(cancelled).toBe(true);
    const result = await exchange(f.server.port!, [frame(Buffer.alloc(0))], {"input-bin":"AA, /w=="});
    expect(status(result)).toBe(5);
    expect(result.headers["reply-bin"]).toBe("Af8=");
    expect(result.trailers["error-bin"]).toBe("Kg==");
    expect(decodeURIComponent(String(result.trailers["grpc-message"]))).toBe("Нет % записи\ufffd");
  } finally { await f.close(); }
});

test("send limit rejects oversized replies and an incomplete upload times out", async () => {
  const f = await serverFor(() => ({text:"x".repeat(1000)}), {serverOptions:{"grpc.max_send_message_length":8}});
  try {
    expect(status(await exchange(f.server.port!, [frame(Buffer.alloc(0))]))).toBe(8);
    expect(status(await exchange(f.server.port!, [Buffer.from([0,0])], {"grpc-timeout":"30m"}, true))).toBe(4);
  } finally { await f.close(); }
});

test("graceful shutdown drains active handlers while startup stop/abort do not leak listeners", async () => {
  let release!: () => void;
  const f = await serverFor(async () => {
    await new Promise<void>((resolve) => { release=resolve; });
    return {text:"done",count:1};
  });
  try {
    const reply = exchange(f.server.port!, [frame(Buffer.alloc(0))]);
    while (!release) await Bun.sleep(1);
    let stopped = false;
    const stopping = f.server.stop().then(() => {stopped=true;});
    await Bun.sleep(20); expect(stopped).toBe(false);
    release(); expect(status(await reply)).toBe(0);
    await stopping; expect(f.server.activeCalls).toBe(0);
  } finally { release?.(); await f.close(); }
  for (const cancel of ["stop","signal"]) {
    const container = createContainer(grpcModule({address:"127.0.0.1:0"}));
    const server = container.resolveAll(HOSTED_SERVICE)[0] as GrpcServer;
    const abort = new AbortController();
    const starting = server.start(abort.signal).catch((error:unknown) => error);
    if (cancel === "stop") await server.stop(); else abort.abort(new Error("cancelled"));
    expect(await starting).toBeInstanceOf(Error);
    await server.stop(); await Bun.sleep(10);
    expect(server.port).toBeUndefined();
    await container.dispose();
  }
});

test("library-specific server options and invalid local limits fail before listening", async () => {
  for (const serverOptions of [{"grpc.max_receive_message_length":-1}, {interceptors:[]}, {"grpc.max_concurrent_streams":0}]) {
    const container = createContainer(grpcModule({serverOptions} as GrpcModuleOptions));
    try { expect(() => container.resolveAll(HOSTED_SERVICE)).toThrow(); }
    finally { await container.dispose(); }
  }
});
