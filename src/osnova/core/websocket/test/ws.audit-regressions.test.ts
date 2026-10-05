import { describe, expect, spyOn, test } from "bun:test";
import { WebSocketServer, type WebSocketServerOptions } from "../ws-server";
import { SessionManager, type SessionState } from "../session-manager";
import { InMemoryWebSocketAdapter } from "../adapter/in-memory.adapter";
import type { WebSocketAdapterHooks } from "../adapter/adapter.interface";
import { BinaryPacketCodec } from "../codec/binary.codec";
import { jsonPacketCodec } from "../codec/json.codec";
import { dispatchWsHandler, WsDispatchError } from "../ws-dispatch";
import type { CompiledWsHandler, RegisteredNamespace } from "../explorer";
import type { AckCallback, OsnovaSocket, ServerPacket } from "../types";

const binaryCodec = new BinaryPacketCodec();
const codecs = [jsonPacketCodec, binaryCodec];

describe("WebSocket audit: codec and acknowledgements", () => {
  for (const codec of codecs) {
    test(`${codec.name}: return, callback and error use the selected wire codec`, async () => {
      const ns = namespace({ handlers: new Map([
        ["echo", handler("echo", (_socket: OsnovaSocket, body: unknown) => body)],
        ["callback", handler("callback", (_socket: OsnovaSocket, _body: unknown, ack: AckCallback) => ack("callback-result"))],
        ["error", handler("error", (_socket: OsnovaSocket, _body: unknown, ack: AckCallback) => ack(undefined, { message: "declined" }))],
      ]) });
      await withRuntime({ namespaces: [ns], codec }, async (runtime) => {
        const peer = await connect(runtime);
        for (const event of ["echo", "callback", "error"]) {
          peer.message(codec.encodeClient({ type: "event", event, data: "echo-result", id: event }));
        }
        await waitFor(() => peer.sent.length === 4);
        expect(peer.sent.every((payload) => typeof payload === (codec === jsonPacketCodec ? "string" : "object"))).toBe(true);
        expect(peer.sent.map(decode).slice(1)).toEqual([
          { v: 1, type: "ack", id: "echo", data: "echo-result" },
          { v: 1, type: "ack", id: "callback", data: "callback-result" },
          { v: 1, type: "error", id: "error", data: { message: "declined" } },
        ]);
      });
    });

    test(`${codec.name}: a remote adapter preserves the local frame type`, async () => {
      let hooks!: WebSocketAdapterHooks;
      class Adapter extends InMemoryWebSocketAdapter {
        override async initialize(value: WebSocketAdapterHooks) { hooks = value; await super.initialize(value); }
      }
      await withRuntime({ namespaces: [namespace()], codec, adapter: new Adapter() }, async (runtime) => {
        const upgrade = upgradeServer();
        await runtime.tryUpgrade(request(), upgrade.server);
        const payload = codec.encodeServer({ type: "event", event: "notice", data: "hello" });
        hooks.localPublish("/audit\0room", typeof payload === "string" ? new TextEncoder().encode(payload) : payload);
        expect(upgrade.published).toHaveLength(1);
        expect(typeof upgrade.published[0]).toBe(typeof payload);
        expect(decode(upgrade.published[0]!)).toEqual(decode(payload));
      });
    });
  }

  test("deferred ACK holds the queue and completes exactly once", async () => {
    let ack!: AckCallback;
    const sent: Array<string | Uint8Array> = [];
    let completed = false;
    const operation = dispatchWsHandler(
      handler("deferred", (_socket: OsnovaSocket, _body: unknown, callback: AckCallback) => { ack = callback; }),
      {} as OsnovaSocket,
      { v: 1, type: "event", event: "deferred", id: "job" },
      (payload) => { sent.push(payload); },
    ).then(() => { completed = true; });
    await waitFor(() => ack !== undefined);
    expect(sent).toEqual([]);
    expect(completed).toBe(false);
    ack({ done: true });
    ack({ duplicate: true });
    await operation;
    expect(sent.map(decode)).toEqual([{ v: 1, type: "ack", id: "job", data: { done: true } }]);
  });

  test("a returned value wins over a later callback", async () => {
    let ack!: AckCallback;
    const sent: Array<string | Uint8Array> = [];
    await dispatchWsHandler(
      handler("return", (_socket: OsnovaSocket, _body: unknown, callback: AckCallback) => { ack = callback; return "returned"; }),
      {} as OsnovaSocket, { v: 1, type: "event", event: "return", id: "id" }, (payload) => { sent.push(payload); },
    );
    ack("late");
    expect(sent.map(decode)).toEqual([{ v: 1, type: "ack", id: "id", data: "returned" }]);
  });

  test("a deferred encoding failure rejects dispatch without escaping the callback", async () => {
    let ack!: AckCallback;
    const operation = dispatchWsHandler(
      handler("deferred", (_socket: OsnovaSocket, _body: unknown, callback: AckCallback) => { ack = callback; }),
      {} as OsnovaSocket, { v: 1, type: "event", event: "deferred", id: "id" }, () => {},
    );
    const outcome = operation.then(() => undefined, (error: unknown) => error);
    await waitFor(() => ack !== undefined);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => ack(circular)).not.toThrow();
    expect(await outcome).toBeInstanceOf(WsDispatchError);
  });

  test("deferred timeout suppresses the late ACK and later queued handlers", async () => {
    let ack!: AckCallback;
    let laterCalls = 0;
    await withRuntime({
      namespaces: [namespace({ handlers: new Map([
        ["deferred", handler("deferred", (_socket: OsnovaSocket, _body: unknown, callback: AckCallback) => { ack = callback; })],
        ["later", handler("later", () => { laterCalls += 1; })],
      ]) })], limits: { messageHandlingTimeoutMs: 10 },
    }, async (runtime) => {
      const peer = await connect(runtime);
      peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "deferred", id: "job" }));
      peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "later", id: "later" }));
      await waitFor(() => peer.closed.length > 0);
      const frames = peer.sent.length;
      ack("late");
      await Bun.sleep(1);
      expect(peer.sent).toHaveLength(frames);
      expect(peer.sent.map(decode).some((packet) => packet.type === "ack")).toBe(false);
      expect(laterCalls).toBe(0);
    });
  });
});

describe("WebSocket audit: replay acceptance", () => {
  for (const codec of codecs) {
    for (const maxPayloadBytes of [512, 65_536]) {
      test(`${codec.name}: replay fits the real ${maxPayloadBytes}-byte envelope`, async () => {
        const adapter = new InMemoryWebSocketAdapter();
        const packet: ServerPacket = { v: 1, type: "event", event: "notice", data: maxPayloadBytes === 512 ? "hi" : "x".repeat(64_000) };
        await adapter.saveSession(session("replay", [packet]));
        await withRuntime({ namespaces: [namespace({ maxPayloadBytes })], adapter, codec }, async (runtime) => {
          const peer = await connect(runtime, "?sid=replay");
          expect(decode(peer.sent[0]!).missed).toEqual([packet]);
          expect(peer.sent.every((payload) => byteLength(payload) <= maxPayloadBytes)).toBe(true);
          await waitFor(async () => (await adapter.loadSession("replay"))?.outboundQueue.length === 0);
        });
      });
    }
  }

  test("overflow replay follows connected as ordinary events in FIFO order", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const packets = ["first", "second", "third"].map((event): ServerPacket => ({ v: 1, type: "event", event, data: "x".repeat(260) }));
    await adapter.saveSession(session("overflow", packets));
    await withRuntime({ namespaces: [namespace({ maxPayloadBytes: 512 })], adapter }, async (runtime) => {
      const peer = await connect(runtime, "?sid=overflow");
      const frames = peer.sent.map(decode);
      expect(frames[0]?.missed).toEqual([packets[0]!]);
      expect(frames.slice(1)).toEqual(packets.slice(1));
      expect(peer.sent.every((payload) => byteLength(payload) <= 512)).toBe(true);
      await waitFor(async () => (await adapter.loadSession("overflow"))?.outboundQueue.length === 0);
    });
  });

  for (const codec of codecs) {
    test(`${codec.name}: control reconnect delivers its replay overflow in order`, async () => {
      const adapter = new InMemoryWebSocketAdapter();
      const packets = ["first", "second"].map((event): ServerPacket => ({ v: 1, type: "event", event, data: "x".repeat(260) }));
      await adapter.saveSession(session("control-replay", packets));
      await withRuntime({ namespaces: [namespace({ maxPayloadBytes: 512 })], adapter, codec }, async (runtime) => {
        const peer = await connect(runtime);
        peer.message(codec.encodeClient({ type: "reconnect", data: { sid: "control-replay" } }));
        await waitFor(() => peer.sent.length === 3);
        const frames = peer.sent.map(decode);
        expect(frames[1]?.type).toBe("reconnected");
        expect([...(frames[1]?.missed ?? []), ...frames.slice(2)]).toEqual(packets);
        expect(peer.sent.every((payload) => byteLength(payload) <= 512)).toBe(true);
        await waitFor(async () => (await adapter.loadSession("control-replay"))?.outboundQueue.length === 0);
      });
    });
  }

  for (const failedSend of [1, 2]) {
    test(`send ${failedSend} rejection preserves every unaccepted replay item`, async () => {
      const adapter = new InMemoryWebSocketAdapter();
      const packets = ["first", "second"].map((event): ServerPacket => ({ v: 1, type: "event", event, data: "x".repeat(260) }));
      await adapter.saveSession(session("failed-send", packets));
      await withRuntime({ namespaces: [namespace({ maxPayloadBytes: 512 })], adapter }, async (runtime) => {
        const peer = await preparePeer(runtime, "?sid=failed-send", (_payload, attempt) => attempt === failedSend ? 0 : 1);
        await waitFor(() => peer.closed.length > 0);
        expect(peer.closed[0]?.code).toBe(1011);
        const remaining = failedSend === 1 ? packets : packets.slice(1);
        await waitFor(async () => JSON.stringify((await adapter.loadSession("failed-send"))?.outboundQueue) === JSON.stringify(remaining));
      });
    });
  }

  test("Bun backpressure (-1) counts as accepted and does not duplicate replay", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    await adapter.saveSession(session("backpressure", [{ v: 1, type: "event", event: "notice", data: "hi" }]));
    await withRuntime({ namespaces: [namespace()], adapter }, async (runtime) => {
      const peer = await preparePeer(runtime, "?sid=backpressure", () => -1);
      await waitFor(() => peer.sent.length === 1);
      expect(decode(peer.sent[0]!).missed).toHaveLength(1);
      expect(peer.closed).toEqual([]);
      await waitFor(async () => (await adapter.loadSession("backpressure"))?.outboundQueue.length === 0);
    });
  });

  test("an oversized individual replay item is retained on close", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const packet: ServerPacket = { v: 1, type: "event", event: "big", data: "x".repeat(600) };
    await adapter.saveSession(session("oversized", [packet]));
    await withRuntime({ namespaces: [namespace({ maxPayloadBytes: 512 })], adapter }, async (runtime) => {
      const peer = await preparePeer(runtime, "?sid=oversized");
      await waitFor(() => peer.closed.length > 0);
      expect(peer.closed[0]?.code).toBe(1009);
      expect((await adapter.loadSession("oversized"))?.outboundQueue).toEqual([packet]);
    });
  });

  test("the public byte-bounded drain preserves a non-fitting first packet", () => {
    const manager = new SessionManager();
    manager.createSession("drain", "/audit", {});
    const packet: ServerPacket = { v: 1, type: "event", event: "event", data: "large" };
    manager.enqueueOutbound("drain", packet);
    expect(manager.drainOutbound("drain", 0)).toEqual([]);
    expect(manager.peekOutbound("drain")).toEqual([packet]);
    expect(manager.drainOutbound("drain")).toEqual([packet]);
  });
});

describe("WebSocket audit: complete admission deadline and open ordering", () => {
  test("a timed-out load retains admission until settlement and cannot add a late session or upgrade", async () => {
    const gate = deferred<SessionState | null>();
    class Adapter extends InMemoryWebSocketAdapter {
      override async loadSession(sid: string) { return sid === "held" ? gate.promise : super.loadSession(sid); }
    }
    await withRuntime({ namespaces: [namespace()], adapter: new Adapter(), limits: { handshakeTimeoutMs: 10, maxConcurrentHandshakes: 1 } }, async (runtime) => {
      const upgrade = upgradeServer();
      try {
        expect((await runtime.tryUpgrade(request("?sid=held"), upgrade.server))?.status).toBe(504);
        expect((await runtime.tryUpgrade(request(), upgrade.server))?.status).toBe(503);
        expect(upgrade.data).toHaveLength(0);
        gate.resolve(session("held"));
        await Bun.sleep(2);
        expect(upgrade.data).toHaveLength(0);
        expect(runtime.getStats().sessions).toBe(0);
        expect(await runtime.tryUpgrade(request(), upgrade.server)).toBeUndefined();
        expect(upgrade.data).toHaveLength(1);
      } finally { gate.resolve(null); }
    });
  });

  for (const failure of ["timeout", "error"] as const) {
    test(`upgrade session save ${failure} is bounded and sanitized`, async () => {
      const gate = deferred<void>();
      class Adapter extends InMemoryWebSocketAdapter {
        override async saveSession(state: SessionState) {
          if ((state.revision ?? 0) > 1) {
            if (failure === "error") throw new Error("private database credential");
            await gate.promise;
          }
          await super.saveSession(state);
        }
        override async compareAndSwapSession(state: SessionState, expected: number) {
          if (failure === "error") throw new Error("private database credential");
          await gate.promise;
          return super.compareAndSwapSession(state, expected);
        }
      }
      const adapter = new Adapter();
      await adapter.saveSession({ ...session("auth"), context: { user: { id: "user" } } });
      await withRuntime({ namespaces: [namespace()], adapter, authenticator: () => ({ id: "user" }), defaultCorsOrigins: ["https://trusted.test"], limits: { handshakeTimeoutMs: 10 } }, async (runtime) => {
        const upgrade = upgradeServer();
        try {
          const response = await runtime.tryUpgrade(request("?sid=auth"), upgrade.server);
          expect(response?.status).toBe(failure === "timeout" ? 504 : 500);
          expect(await response?.text()).not.toContain("credential");
          gate.resolve();
          await Bun.sleep(2);
          expect(upgrade.data).toEqual([]);
        } finally { gate.resolve(); }
      });
    });
  }

  test("early messages wait for persistence and the connection hook, in order", async () => {
    const gate = deferred<void>();
    const calls: Array<{ data: unknown; ready: unknown }> = [];
    class Adapter extends InMemoryWebSocketAdapter {
      override async saveSession(state: SessionState) { await gate.promise; await super.saveSession(state); }
    }
    await withRuntime({ namespaces: [namespace({
      gatewayInstance: { async handleConnection(socket: OsnovaSocket) { await Bun.sleep(5); socket.data.ready = true; } },
      handlers: new Map([["echo", handler("echo", (socket: OsnovaSocket, data: unknown) => { calls.push({ data, ready: socket.data.ready }); return data; })]]),
    })], adapter: new Adapter() }, async (runtime) => {
      try {
        const peer = await preparePeer(runtime);
        peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "echo", data: 1, id: "one" }));
        peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "echo", data: 2, id: "two" }));
        await Bun.sleep(2);
        expect(calls).toEqual([]);
        expect(peer.closed).toEqual([]);
        gate.resolve();
        await waitFor(() => peer.sent.length === 3);
        expect(calls).toEqual([{ data: 1, ready: true }, { data: 2, ready: true }]);
      } finally { gate.resolve(); }
    });
  });

  test("a stalled open times out without running its queued messages", async () => {
    const gate = deferred<void>();
    let calls = 0;
    class Adapter extends InMemoryWebSocketAdapter {
      override async saveSession(state: SessionState) { await gate.promise; await super.saveSession(state); }
    }
    await withRuntime({ namespaces: [namespace({ handlers: new Map([["echo", handler("echo", () => { calls += 1; })]]) })], adapter: new Adapter(), limits: { handshakeTimeoutMs: 10 } }, async (runtime) => {
      try {
        const peer = await preparePeer(runtime);
        peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "echo", id: "early" }));
        await waitFor(() => peer.closed.length > 0);
        expect(peer.closed[0]?.code).toBe(1011);
        gate.resolve();
        await Bun.sleep(2);
        expect(calls).toBe(0);
        expect(peer.sent).toEqual([]);
      } finally { gate.resolve(); }
    });
  });

  test("pending-message capacity also bounds messages waiting for open", async () => {
    const gate = deferred<void>();
    let calls = 0;
    await withRuntime({
      namespaces: [namespace({
        gatewayInstance: { handleConnection: () => gate.promise },
        handlers: new Map([["echo", handler("echo", () => { calls += 1; })]]),
      })], limits: { maxPendingMessagesPerConnection: 1 },
    }, async (runtime) => {
      try {
        const peer = await preparePeer(runtime);
        peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "echo" }));
        peer.message(jsonPacketCodec.encodeClient({ type: "event", event: "echo" }));
        await waitFor(() => peer.closed.length > 0);
        expect(peer.closed[0]?.code).toBe(1013);
        gate.resolve();
        await Bun.sleep(2);
        expect(calls).toBe(0);
      } finally { gate.resolve(); }
    });
  });
});

describe("WebSocket audit: bounded deletion history", () => {
  test("tombstones do not occupy live capacity and stale saves stay rejected after expiration", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const adapter = new InMemoryWebSocketAdapter({ maxEntries: 2, tombstoneTtlMs: 10 });
    try {
      const first = session("first");
      await adapter.saveSession(first);
      await adapter.deleteSession(first.sid, 2);
      await adapter.saveSession(session("second"));
      await adapter.deleteSession("second", 2);
      await adapter.saveSession(session("third"));
      expect((await adapter.loadSession("third"))?.sid).toBe("third");
      await adapter.saveSession(first);
      expect(await adapter.loadSession(first.sid)).toBeNull();
      now += 11;
      await adapter.saveSession(first);
      expect(await adapter.loadSession(first.sid)).toBeNull();
      expect(await adapter.compareAndSwapSession({ ...first, revision: 3 }, 0)).toBe(false);
      await adapter.saveSession(session("third"));
      expect((await adapter.loadSession("third"))?.sid).toBe("third");
    } finally { clock.mockRestore(); await adapter.close(); }
  });

  test("expired-session churn stays bounded and does not strand capacity", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const adapter = new InMemoryWebSocketAdapter({ maxEntries: 2, tombstoneTtlMs: 10 });
    const manager = new SessionManager({ adapter, maxSessions: 2, defaultTtlMs: 5 });
    try {
      for (let i = 0; i < 200; i++) {
        now += 11;
        manager.createSession(`churn-${i}`, "/audit", {});
        await manager.flushAll();
        now += 6;
        manager.purgeExpired();
        await manager.flushAll();
        expect(adapter.sessionCount()).toBe(0);
        expect((adapter as unknown as { tombstones: Map<string, unknown> }).tombstones.size).toBeLessThanOrEqual(2);
      }
    } finally { clock.mockRestore(); await adapter.close(); }
  });

  test("long-lived updates survive the creation window and stale deletes cannot remove them", async () => {
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const adapter = new InMemoryWebSocketAdapter({ maxEntries: 1, tombstoneTtlMs: 10 });
    try {
      const state = session("live");
      await adapter.saveSession(state);
      now += 100;
      await adapter.saveSession({ ...state, revision: 3 });
      await adapter.deleteSession(state.sid, 2);
      expect((await adapter.loadSession(state.sid))?.revision).toBe(3);
      await adapter.deleteSession(state.sid, 4);
      await adapter.saveSession({ ...state, revision: 5 });
      expect(await adapter.loadSession(state.sid)).toBeNull();
      await adapter.saveSession(session("replacement"));
      expect(adapter.sessionCount()).toBe(1);
    } finally { clock.mockRestore(); await adapter.close(); }
  });
});

function namespace(overrides: Partial<RegisteredNamespace> = {}): RegisteredNamespace {
  return { namespace: "/audit", path: "/ws/audit", gatewayInstance: {}, handlers: new Map(), middleware: [], corsOrigins: [], maxPayloadBytes: 65_536, sessionTtlMs: 60_000, ...overrides };
}
function handler(event: string, method: (...args: any[]) => unknown): CompiledWsHandler {
  return { events: [event], handlerName: event, handler: method, arity: method.length };
}
function session(sid: string, outboundQueue: ServerPacket[] = []): SessionState {
  const now = Date.now();
  return { sid, namespace: "/audit", context: {}, rooms: [], createdAt: now, lastSeenAt: now, expiresAt: now + 60_000, ttlMs: 60_000, revision: 1, outboundQueue };
}
function request(suffix = ""): Request {
  return new Request(`http://127.0.0.1/ws/audit${suffix}`, { headers: { upgrade: "websocket" } });
}
function upgradeServer() {
  const data: unknown[] = [];
  const published: Array<string | Uint8Array> = [];
  return { data, published, server: {
    requestIP: () => ({ address: "127.0.0.1", port: 1234, family: "IPv4" }),
    upgrade(_request: Request, options: { data: unknown }) { data.push(options.data); return true; },
    publish(_topic: string, payload: string | Uint8Array) { published.push(payload); return 1; },
  } as unknown as Parameters<WebSocketServer["tryUpgrade"]>[1] };
}
async function withRuntime(options: WebSocketServerOptions, run: (runtime: WebSocketServer) => Promise<void>) {
  const runtime = new WebSocketServer(options);
  await runtime.initialize();
  try { await run(runtime); } finally { await runtime.close(); }
}
async function preparePeer(runtime: WebSocketServer, suffix = "", send: (payload: string | Uint8Array, attempt: number) => number = () => 1) {
  const upgrade = upgradeServer();
  expect(await runtime.tryUpgrade(request(suffix), upgrade.server)).toBeUndefined();
  const callbacks = runtime.createBunHandler();
  const sent: Array<string | Uint8Array> = [];
  const closed: Array<{ code: number; reason: string }> = [];
  let attempts = 0;
  const socket = {
    data: upgrade.data[0],
    send(payload: string | Uint8Array) {
      if (closed.length) return 0;
      const result = send(payload, ++attempts);
      if (result !== 0) sent.push(payload);
      return result;
    },
    close(code = 1000, reason = "") {
      if (closed.length) return;
      closed.push({ code, reason });
      queueMicrotask(() => callbacks.close?.(socket, code, reason));
    },
    terminate() { socket.close(1006, "terminated"); },
    subscribe() {}, unsubscribe() {}, publish() { return 1; },
  } as unknown as Parameters<NonNullable<ReturnType<WebSocketServer["createBunHandler"]>["open"]>>[0];
  callbacks.open?.(socket);
  return { socket, sent, closed, message(payload: string | Uint8Array) { callbacks.message?.(socket, typeof payload === "string" ? payload : Buffer.from(payload)); } };
}
async function connect(runtime: WebSocketServer, suffix = "") {
  const peer = await preparePeer(runtime, suffix);
  await waitFor(() => peer.sent.length > 0 || peer.closed.length > 0);
  expect(peer.closed).toEqual([]);
  return peer;
}
function decode(payload: string | Uint8Array): ServerPacket {
  const bytes = typeof payload === "string" ? undefined : payload;
  return JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(bytes?.[0] === 1 ? bytes.subarray(5) : bytes)) as ServerPacket;
}
function byteLength(payload: string | Uint8Array): number {
  return typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 1000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for WebSocket regression state");
    await Bun.sleep(1);
  }
}
