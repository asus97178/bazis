import { describe, expect, test } from "bun:test";
import { HOSTED_SERVICE, Module, createContainer } from "@/core/di";
import { HttpServer, httpModule } from "@/core/http";
import { WebSocketExplorer, type RegisteredNamespace } from "../explorer";
import { SubscribeMessage, WebSocketGateway, resolveWebSocketGatewayOptions, normalizeNamespace } from "../decorators";
import { jsonPacketCodec } from "../codec/json.codec";
import { extractWebSocketToken } from "../middleware";
import { WebSocketServer } from "../ws-server";
import { websocketModule } from "../websocketModule";
import { SessionCapacityError, SessionManager, type SessionState } from "../session-manager";
import { TopicCache } from "../topic-cache";
import { WsRateLimiter } from "../WsRateLimiter";
import {
  createInstanceId,
  type WebSocketAdapter,
  type WebSocketAdapterHooks,
} from "../adapter/adapter.interface";
import { InMemoryWebSocketAdapter } from "../adapter/in-memory.adapter";
import type { OsnvSocket } from "../types";

describe("WebSocket: decorators & explorer", () => {
  test("normalizeNamespace adds a leading slash and keeps root", () => {
    expect(normalizeNamespace(undefined)).toBe("/");
    expect(normalizeNamespace("/")).toBe("/");
    expect(normalizeNamespace("chat")).toBe("/chat");
    expect(normalizeNamespace("/chat")).toBe("/chat");
  });

  test("resolveWebSocketGatewayOptions derives a /ws path", () => {
    expect(resolveWebSocketGatewayOptions({}).path).toBe("/ws");
    expect(resolveWebSocketGatewayOptions({ namespace: "chat" }).path).toBe("/ws/chat");
    expect(resolveWebSocketGatewayOptions({ path: "/custom" }).path).toBe("/custom");
  });

  test("an unspecified gateway CORS policy inherits the module/server default", () => {
    @WebSocketGateway()
    class InheritedCorsGateway {}
    @WebSocketGateway({ namespace: "public", cors: { origins: ["*"] } })
    class ExplicitWildcardGateway {}

    const namespaces = new WebSocketExplorer().explore([
      new InheritedCorsGateway(),
      new ExplicitWildcardGateway(),
    ]);
    expect(namespaces[0]?.corsOrigins).toEqual([]);
    expect(namespaces[1]?.corsOrigins).toEqual(["*"]);
  });

  test("explorer compiles handlers with arity and namespace", () => {
    @WebSocketGateway({ namespace: "chat" })
    class ChatGateway {
      @SubscribeMessage("ping")
      ping(): string {
        return "pong";
      }

      @SubscribeMessage(["msg", "message"])
      onMessage(_socket: OsnvSocket, _data: unknown): void {}
    }

    const [ns] = new WebSocketExplorer().explore([new ChatGateway()]);
    expect(ns?.namespace).toBe("/chat");
    expect(ns?.path).toBe("/ws/chat");
    expect(ns?.handlers.get("ping")?.arity).toBe(0);
    expect(ns?.handlers.get("msg")?.arity).toBe(2);
    expect(ns?.handlers.get("message")).toBe(ns?.handlers.get("msg"));
  });

  test("explorer rejects duplicate event handlers", () => {
    @WebSocketGateway()
    class Dup {
      @SubscribeMessage("x")
      a(): void {}
      @SubscribeMessage("x")
      b(): void {}
    }
    expect(() => new WebSocketExplorer().explore([new Dup()])).toThrow(/Duplicate/);
  });

  test("explorer rejects duplicate namespaces and paths", () => {
    @WebSocketGateway({ namespace: "same", path: "/ws/first" })
    class First {}
    @WebSocketGateway({ namespace: "/same", path: "/ws/second" })
    class SameNamespace {}
    @WebSocketGateway({ namespace: "other", path: "/ws/first" })
    class SamePath {}

    const explorer = new WebSocketExplorer();
    expect(() => explorer.explore([new First(), new SameNamespace()])).toThrow(/Duplicate WebSocket namespace/);
    expect(() => explorer.explore([new First(), new SamePath()])).toThrow(/Duplicate WebSocket path/);
  });

  test("gateway options reject invalid paths and non-positive limits", () => {
    expect(() => resolveWebSocketGatewayOptions({ path: "relative" })).toThrow(/absolute path/);
    expect(() => resolveWebSocketGatewayOptions({ maxPayloadBytes: 0 })).toThrow(/maxPayloadBytes/);
    expect(() => resolveWebSocketGatewayOptions({ sessionTtlMs: -1 })).toThrow(/sessionTtlMs/);
  });

  test("explorer ignores non-gateway instances", () => {
    class Plain {}
    expect(new WebSocketExplorer().explore([new Plain()])).toHaveLength(0);
  });
});

describe("WebSocket: JSON codec", () => {
  test("encode/decode round-trips a client packet", () => {
    const encoded = jsonPacketCodec.encodeClient({ type: "event", event: "hi", data: { a: 1 }, id: "1" });
    const decoded = jsonPacketCodec.decodeClient(encoded);
    expect(decoded).toEqual({ v: 1, type: "event", event: "hi", data: { a: 1 }, id: "1" });
  });

  test("rejects malformed packets", () => {
    expect(() => jsonPacketCodec.decodeClient("not json")).toThrow();
    expect(() => jsonPacketCodec.decodeClient(JSON.stringify({ type: "event" }))).toThrow();
  });
});

describe("WebSocket: security defaults", () => {
  test("query token is disabled unless explicitly allowed", () => {
    const request = new Request("https://example.test/ws?token=query-token", {
      headers: { authorization: "Bearer header-token" },
    });
    expect(extractWebSocketToken(request)).toBe("header-token");

    const queryOnly = new Request("https://example.test/ws?token=query-token");
    expect(extractWebSocketToken(queryOnly)).toBeNull();
    expect(extractWebSocketToken(queryOnly, { allowQueryToken: true })).toBe("query-token");
  });

  test("authenticated websocket namespaces require explicit origins", () => {
    expect(() =>
      new WebSocketServer({
        namespaces: [{
          namespace: "/secure",
          path: "/ws/secure",
          gatewayInstance: {},
          handlers: new Map(),
          middleware: [],
          corsOrigins: ["https://app.example"],
          maxPayloadBytes: 1024,
          sessionTtlMs: 1000,
        }],
        requireAuth: true,
      }),
    ).toThrow("requireAuth requires an authenticator");

    expect(() =>
      new WebSocketServer({
        namespaces: [{
          namespace: "/secure",
          path: "/ws/secure",
          gatewayInstance: {},
          handlers: new Map(),
          middleware: [],
          corsOrigins: [],
          maxPayloadBytes: 1024,
          sessionTtlMs: 1000,
        }],
        authenticator: () => ({ id: "u1" }),
        requireAuth: true,
      }),
    ).toThrow("requires explicit CORS origins");

    expect(() =>
      new WebSocketServer({
        namespaces: [{
          namespace: "/secure",
          path: "/ws/secure",
          gatewayInstance: {},
          handlers: new Map(),
          middleware: [],
          corsOrigins: ["https://app.example"],
          maxPayloadBytes: 1024,
          sessionTtlMs: 1000,
        }],
        authenticator: () => ({ id: "u1" }),
        requireAuth: true,
      }),
    ).not.toThrow();
  });

  test("operation deadlines accept explicit zero opt-out and reject negatives", () => {
    expect(() => new WebSocketServer({
      namespaces: [registeredNamespace({})],
      limits: {
        handshakeTimeoutMs: 0,
        messageHandlingTimeoutMs: 0,
        shutdownDrainTimeoutMs: 0,
      },
    })).not.toThrow();
    expect(() => new WebSocketServer({
      namespaces: [registeredNamespace({})],
      limits: { messageHandlingTimeoutMs: -1 },
    })).toThrow(/messageHandlingTimeoutMs.*non-negative/);
    expect(() => new WebSocketServer({
      namespaces: [registeredNamespace({})],
      limits: { maxSessions: 0.5 },
    })).toThrow(/maxSessions.*positive/);
  });

  test("malformed authenticator and custom-middleware principals fail closed", async () => {
    const authenticatedNamespace = {
      ...registeredNamespace({}),
      corsOrigins: ["https://app.example"],
    };
    const malformedAuthenticator = new WebSocketServer({
      namespaces: [authenticatedNamespace],
      authenticator: () => ({ id: "" }),
    });
    await malformedAuthenticator.initialize();
    const authenticatorUpgrades: unknown[] = [];
    expect((await malformedAuthenticator.tryUpgrade(
      websocketRequest("/ws/test"),
      createUpgradeServer(authenticatorUpgrades),
    ))?.status).toBe(401);
    expect(authenticatorUpgrades).toHaveLength(0);
    await malformedAuthenticator.close();

    const middlewareNamespace = registeredNamespace({});
    middlewareNamespace.middleware.push((ctx, next) => {
      ctx.data.user = { id: "x".repeat(257) };
      return next();
    });
    const malformedMiddleware = new WebSocketServer({ namespaces: [middlewareNamespace] });
    await malformedMiddleware.initialize();
    const middlewareUpgrades: unknown[] = [];
    expect((await malformedMiddleware.tryUpgrade(
      websocketRequest("/ws/test"),
      createUpgradeServer(middlewareUpgrades),
    ))?.status).toBe(401);
    expect(middlewareUpgrades).toHaveLength(0);
    await malformedMiddleware.close();
  });

  test("server default CORS applies when a gateway did not override it", async () => {
    const inherited = { ...registeredNamespace({}), corsOrigins: [] };
    const runtime = new WebSocketServer({
      namespaces: [inherited],
      defaultCorsOrigins: ["https://trusted.example"],
    });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    try {
      const denied = await runtime.tryUpgrade(new Request("http://localhost/ws/test", {
        headers: { upgrade: "websocket", origin: "https://evil.example" },
      }), bunServer);
      expect(denied?.status).toBe(403);

      expect(await runtime.tryUpgrade(new Request("http://localhost/ws/test", {
        headers: { upgrade: "websocket", origin: "https://trusted.example" },
      }), bunServer)).toBeUndefined();
      expect(upgraded).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});

describe("WebSocket: memory bounds", () => {
  test("rate limiter purges expired buckets and keeps the map bounded", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const limiter = new WsRateLimiter({ maxBuckets: 2, purgeIntervalMs: 0 });
      expect(limiter.check("a", 1, 10)).toBe(true);
      expect(limiter.check("b", 1, 10)).toBe(true);
      expect(limiter.getStats().buckets).toBe(2);

      expect(limiter.check("c", 1, 10)).toBe(true);
      expect(limiter.getStats().buckets).toBe(2);

      now = 2_000;
      expect(limiter.purgeExpired()).toBe(2);
      expect(limiter.getStats().buckets).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("topic cache evicts old entries and supports explicit delete", () => {
    const topics = new TopicCache({ maxTopics: 2 });
    const a = topics.get("/chat", "a");
    topics.get("/chat", "b");
    topics.get("/chat", "c");

    expect(topics.getStats().topics).toBe(2);
    expect(topics.get("/chat", "a")).toBe(a);
    expect(topics.getStats().topics).toBe(2);
    topics.delete("/chat", "a");
    expect(topics.getStats().topics).toBe(1);
  });

  test("session manager purges expired sessions and caps room snapshots", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const sessions = new SessionManager({ defaultTtlMs: 10, maxRoomsPerSession: 2 });
      sessions.createSession("s1", "/chat", {});
      sessions.updateRooms("s1", ["a", "b", "c"]);
      expect(sessions.getSession("s1")?.rooms).toEqual(["a", "b"]);

      now = 2_000;
      expect(sessions.getStats().sessions).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test("each session keeps its namespace-specific reconnect TTL", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const sessions = new SessionManager({ defaultTtlMs: 1_000 });
      sessions.createSession("short", "/short", {}, 10);
      sessions.createSession("long", "/long", {}, 100);
      now += 20;

      expect(sessions.getSession("short")).toBeUndefined();
      expect(sessions.getSession("long")?.ttlMs).toBe(100);
    } finally {
      Date.now = originalNow;
    }
  });

  test("session capacity fails closed without evicting an existing session", () => {
    const sessions = new SessionManager({ maxSessions: 1 });
    sessions.createSession("kept", "/chat", {});

    expect(() => sessions.createSession("rejected", "/chat", {})).toThrow(SessionCapacityError);
    expect(sessions.getSession("kept")?.sid).toBe("kept");
    expect(sessions.getSession("rejected")).toBeUndefined();
  });

  test("session persistence is ordered and flushable per SID", async () => {
    const savedRevisions: number[] = [];
    const adapter = createTestAdapter({
      async saveSession(state) {
        // Without the manager's per-SID chain, later revisions would finish
        // before the deliberately slow first save.
        if (state.revision === 1) {
          await Bun.sleep(5);
        }
        savedRevisions.push(state.revision ?? 0);
      },
    });
    const sessions = new SessionManager({ adapter });

    sessions.createSession("ordered", "/chat", {});
    sessions.updateRooms("ordered", ["one"]);
    sessions.updateContext("ordered", { marker: "latest" });
    await sessions.flushSession("ordered");

    expect(savedRevisions).toEqual([1, 2, 3]);
  });

  test("stale active leases expire and an old connection cannot clear a new owner", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    const adapter = new InMemoryWebSocketAdapter();
    try {
      const sessions = new SessionManager({ adapter, defaultTtlMs: 100, activeLeaseMs: 10 });
      sessions.createSession("lease", "/chat", {});
      await sessions.flushSession("lease");
      expect(await sessions.claimActiveConnection("lease", "old-conn")).toBe(true);

      now += 11;
      expect(sessions.getSession("lease")?.activeConnId).toBeUndefined();
      await sessions.flushSession("lease");
      expect(await sessions.claimActiveConnection("lease", "new-conn")).toBe(true);

      await sessions.releaseActiveConnection("lease", "old-conn");
      expect(sessions.getSession("lease")?.activeConnId).toBe("new-conn");
    } finally {
      Date.now = originalNow;
      await adapter.close();
    }
  });

  test("lease renewal drops stale local ownership after a distributed CAS loss", async () => {
    let claims = 0;
    const adapter = createTestAdapter({
      async compareAndSwapSession(): Promise<boolean> {
        claims += 1;
        return claims === 1;
      },
    });
    const sessions = new SessionManager({ adapter, activeLeaseMs: 100 });
    sessions.createSession("contended", "/chat", {});
    await sessions.flushSession("contended");
    expect(await sessions.claimActiveConnection("contended", "local")).toBe(true);

    expect(await sessions.renewOwnedLeases()).toEqual(["contended"]);
    expect(sessions.getSession("contended")).toBeUndefined();
  });

  test("claim refresh rejects a live owner written by another adapter instance", async () => {
    let stored: SessionState | null = null;
    const adapter = createTestAdapter({
      instanceId: "local-node",
      async saveSession(state): Promise<void> {
        if ((state.revision ?? 0) > (stored?.revision ?? 0)) {
          stored = structuredClone(state);
        }
      },
      async loadSession(): Promise<SessionState | null> {
        return stored ? structuredClone(stored) : null;
      },
      async compareAndSwapSession(state, expectedRevision): Promise<boolean> {
        if ((stored?.revision ?? 0) !== expectedRevision) {
          return false;
        }
        stored = structuredClone(state);
        return true;
      },
    });
    const sessions = new SessionManager({ adapter, activeLeaseMs: 1_000 });
    sessions.createSession("shared", "/chat", {});
    await sessions.flushSession("shared");
    expect(await sessions.claimActiveConnection("shared", "local-conn")).toBe(true);

    stored = {
      ...structuredClone(stored!),
      revision: (stored!.revision ?? 0) + 1,
      activeConnId: "remote-conn",
      ownerInstanceId: "remote-node",
      activeLeaseExpiresAt: Date.now() + 1_000,
    };
    expect(await sessions.claimActiveConnection("shared", "replacement")).toBe(false);
    expect(await sessions.releaseActiveConnection("shared", "local-conn", ["stale-room"])).toBe(false);
    expect(stored.activeConnId).toBe("remote-conn");
    expect(stored.rooms).not.toContain("stale-room");
    expect(sessions.getSession("shared")?.activeConnId).toBe("remote-conn");
  });

  test("offline room replay is indexed and bounded by recipients and bytes", () => {
    const sessions = new SessionManager({
      maxOfflineBroadcastRecipients: 1,
      maxOfflineBroadcastBytes: 256,
    });
    for (const sid of ["a", "b", "c"]) {
      sessions.createSession(sid, "/chat", {});
      sessions.updateRooms(sid, ["room"]);
    }

    const result = sessions.enqueueToOfflineRoomMembers(
      "/chat",
      "room",
      { v: 1, type: "event", event: "notice", data: "hello" },
    );
    expect(result).toMatchObject({ queued: 1, truncated: true });
    expect(sessions.getStats().queuedMessages).toBe(1);

    const oversized = sessions.enqueueToOfflineRoomMembers(
      "/chat",
      "room",
      { v: 1, type: "event", event: "notice", data: "x".repeat(512) },
    );
    expect(oversized).toMatchObject({ queued: 0, truncated: true });
  });
});

describe("WebSocket: lifecycle", () => {
  test("failed gateway initialization rolls back the partial gateway and adapter", async () => {
    const calls: string[] = [];
    const adapter = createTestAdapter({
      async initialize() {
        calls.push("adapter:init");
      },
      async close() {
        await Bun.sleep(2);
        calls.push("adapter:close");
      },
    });
    const gateway = {
      async onGatewayInit(): Promise<void> {
        calls.push("gateway:init");
        throw new Error("init failed");
      },
      async onGatewayShutdown(): Promise<void> {
        await Bun.sleep(2);
        calls.push("gateway:shutdown");
      },
    };
    const server = new WebSocketServer({
      namespaces: [registeredNamespace(gateway)],
      adapter,
    });

    await expect(server.initialize()).rejects.toThrow("init failed");
    expect(calls).toEqual(["adapter:init", "gateway:init", "gateway:shutdown", "adapter:close"]);
  });

  test("normal shutdown awaits gateway and adapter hooks", async () => {
    const calls: string[] = [];
    const adapter = createTestAdapter({
      async close() {
        await Bun.sleep(2);
        calls.push("adapter:close");
      },
    });
    const gateway = {
      async onGatewayShutdown(): Promise<void> {
        await Bun.sleep(2);
        calls.push("gateway:shutdown");
      },
    };
    const server = new WebSocketServer({
      namespaces: [registeredNamespace(gateway)],
      adapter,
    });

    await server.initialize();
    await server.close();
    expect(calls).toEqual(["gateway:shutdown", "adapter:close"]);
  });

  test.each(["success", "error"] as const)("shutdown timeout preserves callback ownership until late %s; every close caller sees the failure", async outcome => {
    let capturedSocket: OsnvSocket | undefined;
    let release!: () => void;
    let shutdowns = 0;
    let adapterCloses = 0;
    const gateway = {
      handleConnection(socket: OsnvSocket): Promise<void> {
        capturedSocket = socket;
        return new Promise((resolve, reject) => {
          release = () => outcome === "success" ? resolve() : reject(new Error("late connection failure"));
        });
      },
      onGatewayShutdown() { shutdowns += 1; },
    };
    const runtime = new WebSocketServer({
      namespaces: [registeredNamespace(gateway)],
      adapter: createTestAdapter({ async close() { adapterCloses += 1; } }),
      limits: { shutdownDrainTimeoutMs: 5 },
    });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    await runtime.tryUpgrade(websocketRequest("/ws/test"), createUpgradeServer(upgraded));
    const socket = createFakeSocket(upgraded[0]);
    runtime.createBunHandler().open?.(socket.socket);
    await waitUntil(() => socket.sent.length > 0);

    const startedAt = Date.now();
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await expect(closing).rejects.toThrow("shutdown timed out");
    expect(shutdowns).toBe(0);
    expect(adapterCloses).toBe(0);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(socket.terminated).toBe(1);
    const sentAfterClose = socket.sent.length;
    capturedSocket?.emit("late", true);
    capturedSocket?.join("late-room");
    expect(socket.sent).toHaveLength(sentAfterClose);
    expect((socket.socket.data as { rooms: Set<string> }).rooms.size).toBe(0);
    release();
    await waitUntil(() => adapterCloses === 1);
    expect(shutdowns).toBe(1);
    expect(runtime.close()).toBe(closing);
    await expect(runtime.close()).rejects.toThrow("shutdown timed out");
  });

  test("versioned tombstones prevent delayed saves from resurrecting sessions", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const now = Date.now();
    const state: SessionState = {
      sid: "deleted",
      namespace: "/chat",
      context: {},
      rooms: [],
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 1000,
      outboundQueue: [],
      revision: 2,
    };
    await adapter.saveSession(state);
    expect(await adapter.loadSession(state.sid)).not.toBeNull();
    await adapter.deleteSession(state.sid, 3);
    await adapter.saveSession(state);
    expect(await adapter.loadSession(state.sid)).toBeNull();
    await adapter.close();
  });

  test("HTTP does not expose a listener when WebSocket initialization fails", async () => {
    @WebSocketGateway({ namespace: "broken-start" })
    class BrokenStartGateway {
      onGatewayInit(): never {
        throw new Error("gateway startup failed");
      }
    }
    @Module({
      imports: [
        httpModule({ port: 0, imports: [] }),
        websocketModule({ gateways: [BrokenStartGateway] }),
      ],
    })
    class App {}

    const container = createContainer(App, { validateOnBuild: true });
    const server = container.resolveAll(HOSTED_SERVICE).find((service): service is HttpServer => service instanceof HttpServer)!;
    await expect(server.start()).rejects.toThrow("gateway startup failed");
    expect(server.port).toBe(-1);
    await server.stop();
    await container.dispose();
  });
});

describe("WebSocket: admission races", () => {
  test.each(["success", "error"] as const)("authenticator %s after timeout releases admission only on settlement", async outcome => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<{ id: string }>((resolve, reject) => {
      release = () => outcome === "success" ? resolve({ id: "u1" }) : reject(new Error("late failure"));
    });
    const namespace = { ...registeredNamespace({}), corsOrigins: ["https://app.example"] };
    const runtime = new WebSocketServer({
      namespaces: [namespace],
      authenticator: () => ++attempts === 1 ? gate : { id: "u1" },
      limits: { maxConcurrentHandshakes: 1, handshakeTimeoutMs: 5 },
    });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    try {
      expect((await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer))?.status).toBe(504);
      for (let index = 0; index < 3; index++) {
        expect((await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer))?.status).toBe(503);
      }
      expect(attempts).toBe(1);
      release();
      await Bun.sleep(0);
      expect(upgraded).toHaveLength(0);
      expect(await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer)).toBeUndefined();
      expect(attempts).toBe(2);
      expect(upgraded).toHaveLength(1);
    } finally { release(); await runtime.close(); }
  });

  test.each(["success", "error"] as const)("handler %s after timeout retains the global slot across connections", async outcome => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<string>((resolve, reject) => {
      release = () => outcome === "success" ? resolve("late") : reject(new Error("late failure"));
    });
    const namespace = registeredNamespace({});
    namespace.handlers.set("hold", { events: ["hold"], handlerName: "hold", arity: 0,
      handler: () => ++calls === 1 ? gate : "accepted" });
    const runtime = new WebSocketServer({ namespaces: [namespace],
      limits: { maxConcurrentMessageHandlers: 1, messageHandlingTimeoutMs: 5 } });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const server = createUpgradeServer(upgraded);
    const handler = runtime.createBunHandler();
    try {
      await runtime.tryUpgrade(websocketRequest("/ws/test"), server);
      const first = createFakeSocket(upgraded.shift());
      handler.open?.(first.socket);
      await waitUntil(() => first.sent.length > 0);
      handler.message?.(first.socket, jsonPacketCodec.encodeClient({ type: "event", event: "hold", id: "first" }));
      await waitUntil(() => first.closed.length > 0);
      const firstFrames = first.sent.length;
      await runtime.tryUpgrade(websocketRequest("/ws/test"), server);
      const second = createFakeSocket(upgraded.shift());
      handler.open?.(second.socket);
      await waitUntil(() => second.sent.length > 0);
      handler.message?.(second.socket, jsonPacketCodec.encodeClient({ type: "event", event: "hold", id: "busy" }));
      await waitUntil(() => second.sent.length > 1);
      expect(decodeServerPacket(second.sent[1]).data).toEqual({ message: "WebSocket service busy" });
      expect(calls).toBe(1);
      release();
      await Bun.sleep(0);
      handler.message?.(second.socket, jsonPacketCodec.encodeClient({ type: "event", event: "hold", id: "accepted" }));
      await waitUntil(() => second.sent.some(payload => decodeServerPacket(payload).id === "accepted"));
      expect(calls).toBe(2);
      expect(first.sent).toHaveLength(firstFrames);
    } finally { release(); await runtime.close(); }
  });

  test("shutdown waits for an actual handler before disconnect and gateway cleanup", async () => {
    const calls: string[] = [];
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const namespace = registeredNamespace({
      handleDisconnect() { calls.push("disconnect"); },
      onGatewayShutdown() { calls.push("gateway"); },
    });
    namespace.handlers.set("hold", { events: ["hold"], handlerName: "hold", arity: 0,
      handler: async () => { started = true; await gate; calls.push("handler"); } });
    const runtime = new WebSocketServer({ namespaces: [namespace],
      adapter: createTestAdapter({ async close() { calls.push("adapter"); } }),
      limits: { shutdownDrainTimeoutMs: 5 } });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    await runtime.tryUpgrade(websocketRequest("/ws/test"), createUpgradeServer(upgraded));
    const peer = createFakeSocket(upgraded[0]);
    const handler = runtime.createBunHandler();
    handler.open?.(peer.socket);
    await waitUntil(() => peer.sent.length > 0);
    handler.message?.(peer.socket, jsonPacketCodec.encodeClient({ type: "event", event: "hold", id: "held" }));
    await waitUntil(() => started);
    try {
      await expect(runtime.close()).rejects.toThrow("shutdown timed out");
      expect(calls).toEqual([]);
      expect(peer.terminated).toBe(1);
    } finally { release(); }
    await waitUntil(() => calls.includes("adapter"));
    expect(calls).toEqual(["handler", "disconnect", "gateway", "adapter"]);
    expect(peer.sent.some(payload => decodeServerPacket(payload).type === "ack")).toBe(false);
    await expect(runtime.close()).rejects.toThrow("shutdown timed out");
  });

  test("validator and handler deadlines fail closed and suppress late effects", async () => {
    for (const kind of ["validator", "handler"] as const) {
      let validatorRelease: ((value: unknown) => void) | undefined;
      let handlerRelease: ((value: unknown) => void) | undefined;
      let handlerCalled = false;
      let capturedSocket: OsnvSocket | undefined;
      let capturedAck: ((value?: unknown) => void) | undefined;
      let capturedNested: { value: string } | undefined;
      let capturedRooms: Set<string> | undefined;
      const namespace = registeredNamespace({});
      namespace.handlers.set("hang", {
        events: ["hang"],
        handlerName: "hang",
        arity: 3,
        ...(kind === "validator"
          ? {
              validate: () => new Promise((resolve) => {
                validatorRelease = resolve;
              }),
            }
          : {}),
        handler: (socket: unknown, _body: unknown, ack: unknown) => {
          handlerCalled = true;
          capturedSocket = socket as OsnvSocket;
          capturedAck = ack as (value?: unknown) => void;
          capturedSocket.data.nested = { value: "before" };
          capturedNested = capturedSocket.data.nested as { value: string };
          capturedRooms = capturedSocket.rooms as Set<string>;
          return kind === "handler"
            ? new Promise((resolve) => {
                handlerRelease = resolve;
              })
            : "unexpected";
        },
      });
      const runtime = new WebSocketServer({
        namespaces: [namespace],
        limits: { messageHandlingTimeoutMs: 5 },
      });
      await runtime.initialize();
      const upgraded: unknown[] = [];
      await runtime.tryUpgrade(websocketRequest("/ws/test"), createUpgradeServer(upgraded));
      const socket = createFakeSocket(upgraded[0]);
      const bunHandler = runtime.createBunHandler();
      bunHandler.open?.(socket.socket);
      await waitUntil(() => socket.sent.length > 0);

      bunHandler.message?.(
        socket.socket,
        jsonPacketCodec.encodeClient({ type: "event", event: "hang", id: "late", data: {} }),
      );
      await waitUntil(() => socket.closed.some((entry) => entry.reason === "message processing timed out"));
      const sentAfterTimeout = socket.sent.length;

      if (kind === "validator") {
        expect(handlerCalled).toBe(false);
        validatorRelease?.({ accepted: true });
        await Bun.sleep(0);
        expect(handlerCalled).toBe(false);
      } else {
        capturedSocket?.join("late-room");
        if (capturedSocket) {
          capturedSocket.data.late = true;
        }
        if (capturedNested) {
          capturedNested.value = "after";
        }
        capturedRooms?.add("late-direct-room");
        capturedAck?.({ late: true });
        handlerRelease?.({ late: true });
        await Bun.sleep(0);
        expect((socket.socket.data as { rooms: Set<string> }).rooms.size).toBe(0);
        expect((socket.socket.data as { context: Record<string, unknown> }).context.late).toBeUndefined();
        const context = (socket.socket.data as { context: Record<string, unknown> }).context;
        expect((context.nested as { value: string }).value).toBe("before");
      }
      expect(socket.sent).toHaveLength(sentAfterTimeout);

      // The timed-out connection is permanently failed closed: queued/new
      // packets cannot start another sequential handler.
      bunHandler.message?.(
        socket.socket,
        jsonPacketCodec.encodeClient({ type: "event", event: "hang", id: "next", data: {} }),
      );
      await Bun.sleep(0);
      expect(socket.sent).toHaveLength(sentAfterTimeout);
      await runtime.close();
    }
  });

  test("message reconnect uses the immutable connection principal, not mutable socket context", async () => {
    const namespace = registeredNamespace({});
    namespace.middleware.push((ctx, next) => {
      const userId = ctx.request.headers.get("x-test-user");
      if (userId) {
        ctx.data.user = { id: userId };
      }
      return next();
    });
    const runtime = new WebSocketServer({ namespaces: [namespace] });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    const bunHandler = runtime.createBunHandler();

    await runtime.tryUpgrade(new Request("http://localhost/ws/test", {
      headers: { upgrade: "websocket", "x-test-user": "alice" },
    }), bunServer);
    const alice = createFakeSocket(upgraded.shift());
    bunHandler.open?.(alice.socket);
    await waitUntil(() => alice.sent.length > 0);
    const aliceSid = (alice.socket.data as { sid: string }).sid;

    await runtime.tryUpgrade(new Request("http://localhost/ws/test", {
      headers: { upgrade: "websocket", "x-test-user": "bob" },
    }), bunServer);
    const bob = createFakeSocket(upgraded.shift());
    bunHandler.open?.(bob.socket);
    await waitUntil(() => bob.sent.length > 0);
    const bobSid = (bob.socket.data as { sid: string }).sid;

    // Gateway data is intentionally mutable, so it must not be the ownership
    // authority for rebinding a physical connection to another user's SID.
    (bob.socket.data as { context: { user?: { id: string } } }).context.user = { id: "alice" };

    bunHandler.message?.(bob.socket, jsonPacketCodec.encodeClient({
      type: "reconnect",
      data: { sid: aliceSid },
      id: "steal",
    }));
    await waitUntil(() => bob.sent.some((payload) => {
      const packet = decodeServerPacket(payload);
      return packet.type === "error" && packet.id === "steal";
    }));

    expect((bob.socket.data as { sid: string }).sid).toBe(bobSid);
    expect(alice.closed).toHaveLength(0);
    expect(bob.sent.map(decodeServerPacket)).toContainEqual(expect.objectContaining({
      type: "error",
      id: "steal",
      data: { message: "Unauthorized reconnect" },
    }));
    await runtime.close();
  });

  test("concurrent upgrades that pass the precheck still close over-capacity sockets", async () => {
    const runtime = new WebSocketServer({
      namespaces: [registeredNamespace({})],
      limits: { maxSessions: 1 },
    });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    const request = websocketRequest("/ws/test");

    expect(await runtime.tryUpgrade(request, bunServer)).toBeUndefined();
    expect(await runtime.tryUpgrade(request, bunServer)).toBeUndefined();
    expect(upgraded).toHaveLength(2);

    const first = createFakeSocket(upgraded[0]);
    const second = createFakeSocket(upgraded[1]);
    const handler = runtime.createBunHandler();
    handler.open?.(first.socket);
    handler.open?.(second.socket);
    await waitUntil(() => first.sent.length > 0 && second.closed.length > 0);

    expect(decodeServerPacket(first.sent[0]).type).toBe("connected");
    expect(second.closed[0]).toMatchObject({ code: 1013, reason: "session capacity exceeded" });
    expect(runtime.getStats().sessions).toBe(1);
    await runtime.close();
  });

  test("a failed replacement claim leaves the existing SID owner connected", async () => {
    const runtime = new WebSocketServer({ namespaces: [registeredNamespace({})] });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    const handler = runtime.createBunHandler();

    await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer);
    const owner = createFakeSocket(upgraded.shift());
    handler.open?.(owner.socket);
    await waitUntil(() => owner.sent.length > 0);
    const sid = (owner.socket.data as { sid: string }).sid;

    const sessions = (runtime as unknown as { sessionManager: SessionManager }).sessionManager;
    sessions.claimActiveConnection = async () => false;

    await runtime.tryUpgrade(websocketRequest(`/ws/test?sid=${sid}`), bunServer);
    const rejected = createFakeSocket(upgraded.shift());
    handler.open?.(rejected.socket);
    await waitUntil(() => rejected.closed.length > 0);

    expect(rejected.closed[0]).toMatchObject({ code: 4009 });
    expect(owner.closed).toHaveLength(0);
    const connections = (runtime as unknown as {
      connectionsBySid: Map<string, unknown>;
    }).connectionsBySid;
    expect(connections.get(sid)).toBe(owner.socket);
    await runtime.close();
  });

  test("a successful replacement suppresses the old socket's in-flight late ack", async () => {
    let capturedAck: ((value?: unknown) => void) | undefined;
    let releaseHandler: ((value?: unknown) => void) | undefined;
    const namespace = registeredNamespace({});
    namespace.handlers.set("hang", {
      events: ["hang"],
      handlerName: "hang",
      arity: 3,
      handler: (_socket: unknown, _body: unknown, ack: unknown) => {
        capturedAck = ack as (value?: unknown) => void;
        return new Promise((resolve) => {
          releaseHandler = resolve;
        });
      },
    });
    const runtime = new WebSocketServer({ namespaces: [namespace] });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    const handler = runtime.createBunHandler();

    await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer);
    const owner = createFakeSocket(upgraded.shift());
    handler.open?.(owner.socket);
    await waitUntil(() => owner.sent.length > 0);
    const sid = (owner.socket.data as { sid: string }).sid;
    handler.message?.(owner.socket, jsonPacketCodec.encodeClient({
      type: "event",
      event: "hang",
      id: "old",
    }));
    await waitUntil(() => capturedAck !== undefined);

    await runtime.tryUpgrade(websocketRequest(`/ws/test?sid=${sid}`), bunServer);
    const replacement = createFakeSocket(upgraded.shift());
    handler.open?.(replacement.socket);
    await waitUntil(() => replacement.sent.length > 0);
    const oldSentAfterReplacement = owner.sent.length;

    capturedAck?.({ late: true });
    releaseHandler?.({ late: true });
    await Bun.sleep(0);

    expect(owner.closed[0]).toMatchObject({ code: 4009, reason: "session replaced" });
    expect(owner.sent).toHaveLength(oldSentAfterReplacement);
    await runtime.close();
  });

  test("a replaced socket's disconnect hook cannot overwrite the new SID owner", async () => {
    const gateway = {
      handleDisconnect(socket: OsnvSocket): void {
        socket.leave("kept-room");
      },
    };
    const runtime = new WebSocketServer({ namespaces: [registeredNamespace(gateway)] });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);
    const handler = runtime.createBunHandler();

    await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer);
    const first = createFakeSocket(upgraded.shift());
    handler.open?.(first.socket);
    await waitUntil(() => first.sent.length > 0);
    const sid = (first.socket.data as { sid: string }).sid;
    const sessions = (runtime as unknown as { sessionManager: SessionManager }).sessionManager;
    sessions.updateRooms(sid, ["kept-room"]);
    (first.socket.data as { rooms: Set<string> }).rooms.add("kept-room");
    await sessions.flushSession(sid);

    await runtime.tryUpgrade(websocketRequest(`/ws/test?sid=${sid}`), bunServer);
    const replacement = createFakeSocket(upgraded.shift());
    handler.open?.(replacement.socket);
    await waitUntil(() => replacement.sent.length > 0);
    handler.close?.(first.socket, 4009, "session replaced");
    await Bun.sleep(0);

    expect(sessions.getSession(sid)?.rooms).toEqual(["kept-room"]);
    await runtime.close();
  });

  test("handshake concurrency is fail-closed and shutdown drains in-flight middleware", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const namespace = registeredNamespace({});
    namespace.middleware.push(async (_ctx, next) => {
      await gate;
      await next();
    });
    const runtime = new WebSocketServer({
      namespaces: [namespace],
      limits: { maxConcurrentHandshakes: 1 },
    });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);

    const first = runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer);
    await Bun.sleep(0);
    const busy = await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer);
    expect(busy?.status).toBe(503);

    let shutdownComplete = false;
    const shutdown = runtime.close().then(() => {
      shutdownComplete = true;
    });
    await Bun.sleep(0);
    expect(shutdownComplete).toBe(false);
    release();

    expect((await first)?.status).toBe(503);
    await shutdown;
    expect(upgraded).toHaveLength(0);
  });

  test("handshake attempt limits reject before upgrade", async () => {
    const runtime = new WebSocketServer({
      namespaces: [registeredNamespace({})],
      limits: { maxHandshakeAttemptsPerWindow: 1 },
    });
    await runtime.initialize();
    const upgraded: unknown[] = [];
    const bunServer = createUpgradeServer(upgraded);

    expect(await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer)).toBeUndefined();
    const limited = await runtime.tryUpgrade(websocketRequest("/ws/test"), bunServer);
    expect(limited?.status).toBe(429);
    expect(upgraded).toHaveLength(1);
    await runtime.close();
  });
});

describe("WebSocket: adapter identity", () => {
  test("creates instance ids with a crypto UUID suffix", () => {
    expect(createInstanceId("node")).toMatch(
      new RegExp(`^node-${process.pid}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
  });
});

function registeredNamespace(gatewayInstance: unknown): RegisteredNamespace {
  return {
    namespace: "/test",
    path: "/ws/test",
    gatewayInstance,
    handlers: new Map(),
    middleware: [],
    corsOrigins: ["*"],
    maxPayloadBytes: 1024,
    sessionTtlMs: 1_000,
  };
}

function createTestAdapter(
  overrides: Partial<WebSocketAdapter> = {},
): WebSocketAdapter {
  const defaults: WebSocketAdapter = {
    name: "test",
    instanceId: "test-instance",
    async initialize(_hooks: WebSocketAdapterHooks): Promise<void> {},
    async publish(): Promise<void> {},
    async saveSession(): Promise<void> {},
    async loadSession(): Promise<SessionState | null> {
      return null;
    },
    async deleteSession(): Promise<void> {},
    async close(): Promise<void> {},
  };
  return { ...defaults, ...overrides };
}

function websocketRequest(path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { upgrade: "websocket" } });
}

function createUpgradeServer(upgraded: unknown[]): Parameters<WebSocketServer["tryUpgrade"]>[1] {
  return {
    requestIP: () => ({ address: "127.0.0.1", port: 1234, family: "IPv4" }),
    upgrade: (_request: Request, options?: { data?: unknown }) => {
      upgraded.push(options?.data);
      return true;
    },
  } as unknown as Parameters<WebSocketServer["tryUpgrade"]>[1];
}

function createFakeSocket(data: unknown): {
  socket: Parameters<NonNullable<ReturnType<WebSocketServer["createBunHandler"]>["open"]>>[0];
  sent: Array<string | Uint8Array>;
  closed: Array<{ code: number; reason: string }>;
  terminated: number;
} {
  const sent: Array<string | Uint8Array> = [];
  const closed: Array<{ code: number; reason: string }> = [];
  let terminated = 0;
  const socket = {
    data,
    send(payload: string | Uint8Array) {
      sent.push(payload);
      return 1;
    },
    close(code = 1000, reason = "") {
      closed.push({ code, reason });
    },
    terminate() {
      terminated += 1;
    },
    subscribe() {},
    unsubscribe() {},
    publish() {
      return 0;
    },
  } as unknown as Parameters<NonNullable<ReturnType<WebSocketServer["createBunHandler"]>["open"]>>[0];
  return {
    socket,
    sent,
    closed,
    get terminated() {
      return terminated;
    },
  };
}

function decodeServerPacket(payload: string | Uint8Array | undefined): {
  type?: string;
  id?: string;
  data?: unknown;
} {
  if (payload === undefined) {
    return {};
  }
  return JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload)) as { type?: string };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for WebSocket test state.");
}
