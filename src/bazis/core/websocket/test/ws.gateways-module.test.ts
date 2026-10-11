import { describe, expect, test } from "bun:test";
import { collectModuleGateways, DI, Module, singleton } from "@/core/di";
import { Controller, Post } from "@/core/http";
import { KernelError, type Logger } from "@/core/kernel";
import { startTestApp, type TestApp } from "@/core/testing";
import { JwtExpiredError } from "@/library/jwt";
import { SubscribeMessage, WebSocketGateway, WebSocketService, websocketModule, type BazisSocket, type ServerPacket } from "@/core/websocket";

// 0.98.31: a gateway is declared by its module (`gateways`, like `controllers`),
// sees that module's providers, and services send through WebSocketService.

/** Last messages of a room; a provider of the chat module, not global. */
class ChatHistory {
  readonly rooms = new Map<string, string[]>();
  add(room: string, text: string): void { this.rooms.set(room, [...(this.rooms.get(room) ?? []), text]); }
  get(room: string): string[] { return this.rooms.get(room) ?? []; }
}

@WebSocketGateway({ namespace: "chat" })
class ChatGateway {
  constructor(private readonly history: ChatHistory) {}
  @SubscribeMessage("join")
  join(socket: BazisSocket, room: string) { socket.join(room); return { room, history: this.history.get(room) }; }
  @SubscribeMessage("crash")
  crash(): never { throw new Error("postgres password=hunter2 refused"); }
  @SubscribeMessage("strict", { validate: (body) => { if (typeof body !== "string") throw new Error("text only"); return body; } })
  strict(_socket: BazisSocket, body: string) { return body; }
}

/** An HTTP controller that notifies a room through the service. */
@Controller("notify")
class NotifyController {
  constructor(private readonly ws: WebSocketService, private readonly history: ChatHistory) {}
  // No codegen over in-repo tests, so no bound parameters: a fixed room.
  @Post("orders") notify() {
    this.history.add("orders", "paid");
    this.ws.to("orders").emit("order-paid", { room: "orders" });
    return { sent: true };
  }
}

// In-repo tests have no codegen run over them: bind the constructors by hand.
DI.bindDeps(ChatGateway, ChatHistory);
DI.bindDeps(NotifyController, WebSocketService, ChatHistory);

@Module({ gateways: [ChatGateway], providers: [singleton(ChatHistory)], controllers: [NotifyController], exports: [] })
class ChatModule {}

class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  debug(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "debug", message, fields }); }
  info(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "info", message, fields }); }
  warn(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "warn", message, fields }); }
  error(message: string, fields?: Record<string, unknown>) { this.lines.push({ level: "error", message, fields }); }
}

/** Opens a socket, waits for `connected`, returns a request helper that matches by id. */
async function connect(app: TestApp, query = ""): Promise<{ ws: WebSocket; request: (event: string, data?: unknown) => Promise<ServerPacket>; events: ServerPacket[] }> {
  const ws = new WebSocket(`${app.url.replace("http", "ws")}/ws/chat${query}`);
  const events: ServerPacket[] = [];
  const waiters = new Map<string, (packet: ServerPacket) => void>();
  let seq = 0;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("connection failed")), { once: true });
    ws.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as ServerPacket;
      if (packet.type === "connected") resolve();
      else if (packet.id && waiters.has(packet.id)) { waiters.get(packet.id)!(packet); waiters.delete(packet.id); }
      else events.push(packet);
    });
  });
  const request = (event: string, data?: unknown) => new Promise<ServerPacket>((resolve) => {
    const id = String(++seq);
    waiters.set(id, resolve);
    ws.send(JSON.stringify({ v: 1, type: "event", event, data, id }));
  });
  return { ws, request, events };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}

describe("gateways declared by their module", () => {
  test("a gateway sees the providers of its own module and is served without websocket options", async () => {
    const app = await startTestApp(ChatModule, { http: {} });
    try {
      const ann = await connect(app);
      expect((await ann.request("join", "general")).data).toEqual({ room: "general", history: [] });
      ann.ws.close();
    } finally {
      await app.stop();
    }
  });

  test("websocket options without any gateway stop the start", async () => {
    @Module({ providers: [singleton(ChatHistory)] })
    class NoGateways {}
    await expect(startTestApp(NoGateways, { http: {}, websocket: { requireAuth: false } })).rejects.toThrow(KernelError);
    await expect(startTestApp(NoGateways, { http: {}, websocket: {} })).rejects.toThrow("no module declares gateways");
    expect(() => websocketModule({ imports: [NoGateways] })).toThrow("no module of imports declares gateways");
  });

  test("collectModuleGateways walks imports and drops duplicates", () => {
    @Module({ gateways: [ChatGateway] }) class A {}
    @Module({ imports: [A], gateways: [ChatGateway] }) class B {}
    expect(collectModuleGateways([B, A])).toEqual([ChatGateway]);
    expect(collectModuleGateways([{ providers: [] }])).toEqual([]);
  });
});

describe("WebSocketService", () => {
  test("a controller sends an event to a room; the members receive it", async () => {
    const app = await startTestApp(ChatModule, { http: {} });
    try {
      const ann = await connect(app);
      const bob = await connect(app);
      await ann.request("join", "orders");
      await bob.request("join", "elsewhere");
      expect((await app.fetch("/notify/orders", { method: "POST" })).status).toBe(200);
      await waitFor(() => ann.events.length === 1);
      expect(ann.events[0]).toMatchObject({ type: "event", namespace: "/chat", event: "order-paid", data: { room: "orders" } });
      expect(bob.events).toEqual([]);
      // Delivery from a service counts for the room's history like any other.
      expect((await bob.request("join", "orders")).data).toEqual({ room: "orders", history: ["paid"] });
      ann.ws.close(); bob.ws.close();
    } finally {
      await app.stop();
    }
  });

  test("to(room) needs one namespace; namespace(name) picks one; a stopped server refuses", async () => {
    @WebSocketGateway({ namespace: "admin" })
    class AdminGateway {}
    @Module({ gateways: [ChatGateway, AdminGateway], providers: [singleton(ChatHistory)] })
    class Two {}
    const app = await startTestApp(Two, { http: {} });
    const service = app.container.resolve(WebSocketService);
    try {
      expect(() => service.to("x")).toThrow("WebSocketService.to(room) needs exactly one namespace, found 2 (/chat, /admin); use namespace(name).to(room).");
      expect(() => service.namespace("chat").to("x").emit("ping")).not.toThrow();
      expect(() => service.namespace("/chat").to("x").emit("ping")).not.toThrow();
      expect(() => service.namespace("nope").to("x").emit("ping")).toThrow('Unknown WebSocket namespace "nope"; registered: /chat, /admin.');
    } finally {
      await app.stop();
    }
    expect(() => service.namespace("chat").to("x").emit("ping")).toThrow("WebSocket server is not running.");
  });
});

describe("failures reach the application log", () => {
  test("a handler exception is logged redacted; a validation failure is not", async () => {
    const logger = new RecordingLogger();
    const app = await startTestApp(ChatModule, { http: {}, configure: (builder) => builder.useLogger(logger) });
    try {
      const ann = await connect(app);
      expect((await ann.request("crash")).data).toEqual({ message: "Handler failed" });
      expect((await ann.request("strict", 42)).data).toEqual({ message: "Invalid message payload" });
      ann.ws.close();
      const failures = logger.lines.filter((line) => line.message === "WebSocket handler failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]!.fields).toMatchObject({ namespace: "/chat", event: "crash", error: { message: "postgres password=*** refused" } });
      expect(JSON.stringify(logger.lines)).not.toContain("hunter2");
    } finally {
      await app.stop();
    }
  });

  test("a bad token answers 401 and a failing upgrade middleware answers 500 and is logged", async () => {
    const logger = new RecordingLogger();
    const app = await startTestApp(ChatModule, {
      http: {},
      configure: (builder) => builder.useLogger(logger),
      websocket: {
        authenticator: (token) => { if (token === "expired") throw new JwtExpiredError(); if (token === "boom") throw new Error("identity provider down"); return null; },
        requireAuth: true,
        cors: { origins: ["http://app.test"] },
      },
    });
    const upgrade = (token?: string) => app.fetch("/ws/chat", { headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } });
    try {
      expect((await upgrade()).status).toBe(401);
      expect((await upgrade("expired")).status).toBe(401);
      expect((await upgrade("boom")).status).toBe(500);
      const failures = logger.lines.filter((line) => line.message === "WebSocket upgrade failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]!.fields).toMatchObject({ path: "/ws/chat", error: { message: "identity provider down" } });
    } finally {
      await app.stop();
    }
  });
});
