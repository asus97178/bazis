import { expect, test } from "bun:test";
import { createServer, constants, type ServerHttp2Session, type ServerHttp2Stream, type OutgoingHttpHeaders, type IncomingHttpHeaders } from "node:http2";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { GrpcClient, GrpcStatus as Status, type GrpcClientOptions } from "../index";
import { echoService, type EchoMessage } from "./fixtures/contract";

// Fixed protobuf bytes, independent of production and test codec implementations.
const message = Buffer.from("00000000050a01781007", "hex"); // {text:'x', count:7}
const empty = Buffer.from("0000000000", "hex");
async function mock(handler: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void) {
  const server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  let connected = 0, calls = 0;
  server.on("session", session => {
    connected++; sessions.add(session); session.on("error", () => {}); session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => { calls++; stream.on("error", () => {}); handler(stream as ServerHttp2Stream, headers); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { address, sessions, get connected() { return connected; }, get calls() { return calls; },
    client: (options: Partial<GrpcClientOptions> = {}) => new GrpcClient(echoService, { address, timeoutMs: 2000, ...options }),
    async close() { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
function reply(stream: ServerHttp2Stream, body: Buffer = message, trailers: OutgoingHttpHeaders = { "grpc-status": "0" }, headers: OutgoingHttpHeaders = {}) {
  stream.resume();
  stream.respond({ ":status": 200, "content-type": "application/grpc+proto", ...headers }, { waitForTrailers: true });
  stream.on("wantTrailers", () => { if (!stream.destroyed) stream.sendTrailers(trailers); });
  stream.end(body);
}

test("client wire: exact request bytes/headers, fragmented responses, metadata and one reused session", async () => {
  const requests: Buffer[] = [], seen: IncomingHttpHeaders[] = [];
  const f = await mock((stream, headers) => {
    seen.push(headers);
    const chunks: Buffer[] = []; stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => requests.push(Buffer.concat(chunks)));
    stream.respond({ ":status": 200, "content-type": "application/grpc", "reply-bin": "AA, /w==" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0", "tail-bin": "Kg==" }));
    void (async () => { for (const byte of message) { stream.write(Buffer.from([byte])); await Bun.sleep(1); } stream.end(); })();
  });
  const client = f.client();
  try {
    for (let i = 0; i < 3; i++) {
      const result = await client.unary<EchoMessage, EchoMessage>("Echo", { text: "x", count: 7 });
      expect(result.data).toEqual({ text: "x", count: 7 });
      expect(result.metadata.get("reply-bin")).toEqual([Buffer.from([0]), Buffer.from([255])]);
      expect(result.trailers.get("tail-bin")).toEqual([Buffer.from([42])]);
    }
    expect(f.connected).toBe(1); expect(requests).toEqual([message, message, message]);
    for (const headers of seen) {
      expect(headers[":method"]).toBe("POST"); expect(headers[":path"]).toBe("/osnv.test.Echo/Echo");
      expect(headers.te).toBe("trailers"); expect(headers["grpc-timeout"]).toMatch(/^\d{1,8}m$/);
    }
  } finally { client.close(); await f.close(); }
});

test("client wire: empty message, invalid framing/protobuf, cardinality and bounded receive allocation", async () => {
  let body: Buffer = empty;
  const f = await mock(stream => reply(stream, body));
  const client = f.client({ maxReceiveMessageLength: 32 });
  try {
    expect((await client.unary("Echo", {})).data).toEqual({ text: "", count: 0 });
    const cases: [Buffer, number][] = [
      [Buffer.alloc(0), Status.INTERNAL], [Buffer.concat([empty, empty]), Status.INTERNAL],
      [Buffer.from("000000", "hex"), Status.INTERNAL], [Buffer.from("0000000002ff", "hex"), Status.INTERNAL],
      [Buffer.from("0200000000", "hex"), Status.INTERNAL], [Buffer.from("0100000000", "hex"), Status.UNIMPLEMENTED],
      [Buffer.from("00ffffffff", "hex"), Status.RESOURCE_EXHAUSTED], [Buffer.from("000000000100", "hex"), Status.INTERNAL],
    ];
    for (const [value, code] of cases) { body = value; const error = await client.unary("Echo", {}).then(() => null, error => error); expect(error).toMatchObject({ code }); }
    body = message;
    expect((await client.unary("Echo", {})).data).toEqual({ text: "x", count: 7 });
    expect(client.activeCalls).toBe(0);
  } finally { client.close(); await f.close(); }
});

test("client wire: missing/invalid grpc-status, HTTP fallback mapping and terminal status priority", async () => {
  let headers: OutgoingHttpHeaders = {}, trailers: OutgoingHttpHeaders = {};
  const f = await mock(stream => reply(stream, message, trailers, headers));
  const client = f.client();
  try {
    for (const [http, code] of [[200, 2], [400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [500, 2]]) {
      headers = { ":status": http };
      const error = await client.unary("Echo", {}).then(() => null, error => error);
      expect(error).toMatchObject({ code });
    }
    headers = { ":status": 503 }; trailers = { "grpc-status": "5", "grpc-message": "%D0%BD%D0%B5%D1%82%ZZ" };
    expect(await client.unary("Echo", {}).then(() => null, error => error)).toMatchObject({ code: Status.NOT_FOUND });
    headers = {};
    for (const status of ["99", "abc", "0, 0"]) { trailers = { "grpc-status": status }; expect(await client.unary("Echo", {}).then(() => null, error => error)).toMatchObject({ code: Status.UNKNOWN }); }
    headers = { "content-type": "application/json" }; trailers = { "grpc-status": "0" };
    expect(await client.unary("Echo", {}).then(() => null, error => error)).toMatchObject({ code: Status.INTERNAL });
  } finally { client.close(); await f.close(); }
});

test("client wire: trailers-only errors stop a stalled upload and invalid metadata rejects", async () => {
  let badMetadata = false;
  const f = await mock(stream => {
    stream.resume();
    if (badMetadata) reply(stream, message, { "grpc-status": "0", "bad-bin": "!" });
    else stream.respond({ ":status": 200, "content-type": "application/grpc", "grpc-status": "7", "grpc-message": "Denied" }, { endStream: true });
  });
  const client = f.client();
  let returned = 0;
  try {
    const input: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => { returned++; return { done: true, value: undefined }; } }) };
    await expect(client.clientStream("Collect", input)).rejects.toMatchObject({ code: Status.PERMISSION_DENIED });
    expect(returned).toBe(1);
    badMetadata = true;
    await expect(client.unary("Echo", {})).rejects.toMatchObject({ code: Status.INTERNAL });
    expect(client.activeCalls).toBe(0);
  } finally { client.close(); await f.close(); }
});

test("client wire: GOAWAY reconnects only new RPCs, REFUSED_STREAM is never retried", async () => {
  let refuse = false;
  const f = await mock(stream => {
    if (refuse) { stream.close(constants.NGHTTP2_REFUSED_STREAM); return; }
    reply(stream);
  });
  const client = f.client();
  try {
    await client.unary("Echo", {});
    for (const session of f.sessions) session.goaway();
    await Bun.sleep(20);
    expect((await client.unary("Echo", {})).data).toEqual({ text: "x", count: 7 });
    expect(f.connected).toBe(2);
    refuse = true;
    const refused = await client.unary("Echo", {}).then(() => null, error => error);
    expect(refused).toMatchObject({ code: Status.UNAVAILABLE });
    expect(f.calls).toBe(3);
    refuse = false;
    expect((await client.unary("Echo", {})).data).toEqual({ text: "x", count: 7 });
  } finally { client.close(); await f.close(); }
});

test("client wire: full duplex upload proceeds one message at a time while replies are read", async () => {
  let uploaded = 0;
  const f = await mock(stream => {
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.on("data", (chunk: Buffer) => { uploaded += chunk.length; stream.write(chunk); });
    stream.on("end", () => stream.end());
  });
  const client = f.client();
  let allowNext!: () => void;
  const nextAllowed = new Promise<void>(resolve => { allowNext = resolve; });
  async function* input() { yield { text: "x", count: 7 }; await nextAllowed; yield { text: "x", count: 7 }; }
  try {
    const stream = client.bidi<EchoMessage, EchoMessage>("Chat", input());
    let received = 0;
    for await (const value of stream) { expect(value).toEqual({ text: "x", count: 7 }); received++; allowNext(); }
    expect(received).toBe(2); expect(uploaded).toBe(message.length * 2);
  } finally { client.close(); await f.close(); }
});

test("client wire: RST_STREAM maps to gRPC errors, including after initial headers", async () => {
  let reset: number = constants.NGHTTP2_CANCEL, withHeaders = false;
  // Emit actual HTTP/2 frames independently of the server runtime's close().
  const frame = (type: number, flags: number, id: number, body = Buffer.alloc(0)): Buffer => {
    const header = Buffer.alloc(9); header.writeUIntBE(body.length, 0, 3); header[3] = type; header[4] = flags; header.writeUInt32BE(id, 5);
    return Buffer.concat([header, body]);
  };
  const sockets = new Set<Socket>();
  const server = createTcpServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.write(frame(4, 0, 0));
    let buffer: Buffer = Buffer.alloc(0), preface = false;
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (!preface) { if (buffer.length < 24) return; buffer = buffer.subarray(24); preface = true; }
      while (buffer.length >= 9) {
        const length = buffer.readUIntBE(0, 3); if (buffer.length < 9 + length) return;
        const type = buffer[3], flags = buffer[4]!, id = buffer.readUInt32BE(5) & 0x7fffffff;
        buffer = buffer.subarray(9 + length);
        if (type === 4 && !(flags & 1)) socket.write(frame(4, 1, 0));
        if (type === 1) {
          // HPACK static :status=200 and literal content-type=application/grpc.
          if (withHeaders) socket.write(frame(1, 4, id, Buffer.concat([Buffer.from([0x88, 0x0f, 0x10, 0x10]), Buffer.from("application/grpc")])));
          const status = Buffer.alloc(4); status.writeUInt32BE(reset);
          socket.write(frame(3, 0, id, status));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new GrpcClient(echoService, { address: `127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 2000 });
  try {
    for (const headers of [false, true]) {
      withHeaders = headers;
      for (const [rst, code] of [[constants.NGHTTP2_CANCEL, Status.CANCELLED], [constants.NGHTTP2_REFUSED_STREAM, Status.UNAVAILABLE],
        [constants.NGHTTP2_INTERNAL_ERROR, Status.INTERNAL], [constants.NGHTTP2_ENHANCE_YOUR_CALM, Status.RESOURCE_EXHAUSTED],
        [constants.NGHTTP2_INADEQUATE_SECURITY, Status.PERMISSION_DENIED]]) {
        reset = rst!;
        // Await network completion outside Bun's synchronous .rejects matcher.
        const error = await client.unary("Echo", {}).then(() => null, error => error);
        expect(error?.code).toBe(code);
      }
    }
  } finally { client.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("client wire: stalled receiver applies upload backpressure and deadline closes the producer", async () => {
  const f = await mock(() => {}); // Never consume request DATA or return headers.
  const client = f.client();
  let pulled = 0, returned = 0;
  async function* input() {
    try { for (let i = 0; i < 100; i++) { pulled++; yield { text: "x".repeat(128 * 1024), count: i }; } }
    finally { returned++; }
  }
  try {
    const error = await client.clientStream("Collect", input(), { timeoutMs: 50 }).then(() => null, error => error);
    expect(error).toMatchObject({ code: Status.DEADLINE_EXCEEDED });
    expect(pulled).toBe(1); expect(returned).toBe(1); expect(client.activeCalls).toBe(0);
  } finally { client.close(); await f.close(); }
});

test("client wire: early HTTP failure without trailers stops a backpressured upload promptly", async () => {
  const f = await mock(stream => { stream.respond({ ":status": 503, "content-type": "text/plain" }); stream.end(); });
  const client = f.client();
  let returned = 0;
  async function* input() { try { yield { text: "x".repeat(256 * 1024) }; } finally { returned++; } }
  try {
    const error = await client.clientStream("Collect", input(), { timeoutMs: 300 }).then(() => null, error => error);
    expect(error?.code).toBe(Status.UNAVAILABLE); expect(returned).toBe(1); expect(client.activeCalls).toBe(0);
  } finally { client.close(); await f.close(); }
});
