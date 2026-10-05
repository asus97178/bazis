import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createConnection } from "node:net";
import { HOSTED_SERVICE, Module, createContainer, type DiContainer } from "@/core/di";
import { HttpServer, httpModule } from "@/core/http";
import {
  SubscribeMessage,
  WebSocketGateway,
  websocketModule,
  type AckCallback,
  type ClientPacket,
  type OsnvSocket,
  type ServerPacket,
} from "@/core/websocket";

const deadlineReleases = new Set<() => void>();

function holdDeadlineWork(): Promise<void> {
  return new Promise((resolve) => {
    const release = (): void => { deadlineReleases.delete(release); resolve(); };
    deadlineReleases.add(release);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WebSocket e2e state timed out");
    await Bun.sleep(1);
  }
}

@WebSocketGateway({ namespace: "chat" })
class ChatGateway {
  connections = 0;
  disconnects = 0;
  slowHandlers = 0;
  maxConcurrentSlowHandlers = 0;

  handleConnection(): void {
    this.connections += 1;
  }

  handleDisconnect(): void {
    this.disconnects += 1;
  }

  @SubscribeMessage("echo")
  echo(_socket: OsnvSocket, data: unknown): { echoed: unknown } {
    return { echoed: data };
  }

  @SubscribeMessage("join")
  join(socket: OsnvSocket, room: string): { joined: string } {
    socket.join(room);
    return { joined: room };
  }

  @SubscribeMessage("broadcast")
  broadcast(socket: OsnvSocket, payload: { room: string; text: string }): void {
    socket.to(payload.room).emit("message", payload.text);
  }

  @SubscribeMessage("explode", { rateLimit: { limit: 1, windowMs: 60_000 } })
  explode(_socket: OsnvSocket, _data: unknown, ack: AckCallback): void {
    ack(undefined, { message: "boom" });
  }

  @SubscribeMessage("strict", {
    validate: (body): { name: string } => {
      const name = (body as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error("name is required");
      }
      return { name: name.trim() };
    },
  })
  strict(_socket: OsnvSocket, body: { name: string }): { name: string } {
    return body;
  }

  @SubscribeMessage("secret-failure")
  secretFailure(): never {
    throw new Error("postgres password=hunter2");
  }

  @SubscribeMessage("never-validator", {
    validate: () => holdDeadlineWork(),
  })
  neverValidator(): void {}

  @SubscribeMessage("never-handler")
  neverHandler(): Promise<void> {
    return holdDeadlineWork();
  }

  @SubscribeMessage("slow")
  async slow(_socket: OsnvSocket, value: number): Promise<number> {
    this.slowHandlers += 1;
    this.maxConcurrentSlowHandlers = Math.max(this.maxConcurrentSlowHandlers, this.slowHandlers);
    try {
      await Bun.sleep(value === 1 ? 10 : 0);
      return value;
    } finally {
      this.slowHandlers -= 1;
    }
  }
}

@WebSocketGateway({ namespace: "tiny", maxPayloadBytes: 256 })
class TinyGateway {
  @SubscribeMessage("echo")
  echo(_socket: OsnvSocket, data: unknown): unknown {
    return data;
  }

  @SubscribeMessage("large-response")
  largeResponse(): string {
    return "x".repeat(512);
  }
}

@WebSocketGateway({
  namespace: "custom-auth",
  middleware: [
    (ctx, next) => {
      const userId = new URL(ctx.request.url).searchParams.get("user");
      if (userId) {
        ctx.data.user = { id: userId };
      }
      return next();
    },
  ],
})
class CustomAuthGateway {}

let container: DiContainer;
let server: HttpServer;
let gateway: ChatGateway;
let base: string;

beforeEach(async () => {
  @Module({
    imports: [
      httpModule({ port: 0, imports: [] }),
      websocketModule({
        gateways: [ChatGateway, TinyGateway, CustomAuthGateway],
        limits: {
          maxIngressPacketsPerWindow: 2,
          maxControlFramesPerWindow: 1,
          activeSessionLeaseMs: 100,
          leaseRenewIntervalMs: 20,
          messageHandlingTimeoutMs: 50,
        },
      }),
    ],
  })
  class App {}

  container = createContainer(App, { validateOnBuild: true });
  gateway = container.resolve(ChatGateway);
  server = container.resolveAll(HOSTED_SERVICE).find((s): s is HttpServer => s instanceof HttpServer)!;
  await server.start();
  base = `ws://localhost:${server.port}/ws/chat`;
});

afterEach(async () => {
  await server.stop();
  await container.dispose();
});

/** Opens a socket and resolves with it (and its sid) once `connected` arrives. */
function connectFull(query = ""): Promise<{ ws: WebSocket; sid: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${query}`);
    ws.addEventListener("error", reject, { once: true });
    ws.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as ServerPacket;
      if (packet.type === "connected") {
        resolve({ ws, sid: packet.sid ?? "" });
      }
    });
  });
}

/** Opens a socket and resolves once the server's `connected` frame arrives. */
async function connect(query = ""): Promise<WebSocket> {
  return (await connectFull(query)).ws;
}

/** Reconnects by session id and resolves with the physical socket and frame. */
function reconnectFull(sid: string): Promise<{ ws: WebSocket; frame: ServerPacket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}?sid=${encodeURIComponent(sid)}`);
    ws.addEventListener("error", reject, { once: true });
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerPacket;
      if (frame.type === "reconnected") {
        resolve({ ws, frame });
      }
    });
  });
}

/** Sends a client packet and waits for the next matching server frame. */
function request(
  ws: WebSocket,
  packet: Omit<ClientPacket, "v">,
  match: (packet: ServerPacket) => boolean,
): Promise<ServerPacket> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      const received = JSON.parse(String(event.data)) as ServerPacket;
      if (match(received)) {
        ws.removeEventListener("message", onMessage);
        resolve(received);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ v: 1, ...packet }));
  });
}

describe("WebSocket: e2e over the shared HTTP port", () => {
  test("upgrades, runs handleConnection and acks an echo", async () => {
    const ws = await connect();
    expect(gateway.connections).toBe(1);

    const ack = await request(ws, { type: "event", event: "echo", data: "hi", id: "1" }, (p) => p.type === "ack");
    expect(ack.id).toBe("1");
    expect(ack.data).toEqual({ echoed: "hi" });
    ws.close();
  });

  test("an explicit ack error is delivered", async () => {
    const ws = await connect();
    const err = await request(ws, { type: "event", event: "explode", id: "9" }, (p) => p.type === "error");
    expect(err.id).toBe("9");
    expect(err.data).toMatchObject({ message: "boom" });
    ws.close();
  });

  test("rate limit blocks the second call in the window", async () => {
    const ws = await connect();
    await request(ws, { type: "event", event: "explode", id: "a" }, (p) => p.id === "a");
    const blocked = await request(ws, { type: "event", event: "explode", id: "b" }, (p) => p.id === "b");
    expect(blocked.type).toBe("error");
    expect(blocked.data).toMatchObject({ message: "Too many requests" });
    ws.close();
  });

  test("a failing body validator rejects with an error frame", async () => {
    const ws = await connect();
    const err = await request(ws, { type: "event", event: "strict", data: { name: "" }, id: "v1" }, (p) => p.type === "error");
    expect(err.id).toBe("v1");
    expect(err.data).toMatchObject({ message: "Invalid message payload" });
    ws.close();
  });

  test("a passing validator forwards the coerced body to the handler", async () => {
    const ws = await connect();
    const ack = await request(ws, { type: "event", event: "strict", data: { name: "  Ada  " }, id: "v2" }, (p) => p.type === "ack");
    expect(ack.data).toEqual({ name: "Ada" });
    ws.close();
  });

  test("unknown events return an error frame", async () => {
    const ws = await connect();
    const err = await request(ws, { type: "event", event: "nope", id: "7" }, (p) => p.type === "error");
    expect(err.data).toMatchObject({ message: "Unknown event" });
    ws.close();
  });

  test("handler exception details are sanitized by default", async () => {
    const ws = await connect();
    const err = await request(
      ws,
      { type: "event", event: "secret-failure", id: "secret" },
      (packet) => packet.id === "secret",
    );
    expect(err).toMatchObject({ type: "error", data: { message: "Handler failed" } });
    expect(JSON.stringify(err)).not.toContain("hunter2");
    ws.close();
  });

  test("unsettled validators and handlers close their connection on deadline", async () => {
    try {
      for (const event of ["never-validator", "never-handler"]) {
        const ws = await connect();
        const closed = new Promise<CloseEvent>((resolve) => {
          ws.addEventListener("close", resolve, { once: true });
        });
        ws.send(JSON.stringify({ v: 1, type: "event", event, id: event }));

        const closeEvent = await closed;
        expect(closeEvent.code).toBe(1011);
        expect(closeEvent.reason).toBe("message processing timed out");
      }
      expect(deadlineReleases.size).toBe(2);
    } finally {
      // Timeout ends transport waiting, not the callbacks. Release both sources
      // so the unchanged strict afterEach can prove an actual clean shutdown.
      for (const release of deadlineReleases) release();
    }
  });

  test("HttpServer.stop reports unresolved WebSocket work and still closes the listener", async () => {
    let release!: () => void;
    let started = false;
    const order: string[] = [];
    const held = new Promise<void>((resolve) => { release = resolve; });
    @WebSocketGateway({ namespace: "shutdown" })
    class ShutdownGateway {
      @SubscribeMessage("hold")
      async hold(): Promise<void> { started = true; await held; order.push("handler"); }
      onGatewayShutdown(): void { order.push("gateway"); }
    }
    @Module({ imports: [httpModule({ port: 0 }), websocketModule({ gateways: [ShutdownGateway],
      limits: { shutdownDrainTimeoutMs: 20, messageHandlingTimeoutMs: 0 } })] })
    class ShutdownApp {}
    const isolated = createContainer(ShutdownApp, { validateOnBuild: true });
    const host = isolated.resolveAll(HOSTED_SERVICE).find((service): service is HttpServer => service instanceof HttpServer)!;
    let ws: WebSocket | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await host.start();
      const port = host.port;
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws/shutdown`);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener("error", reject, { once: true });
        ws!.addEventListener("message", (event) => {
          if ((JSON.parse(String(event.data)) as ServerPacket).type === "connected") resolve();
        });
      });
      ws.send(JSON.stringify({ v: 1, type: "event", event: "hold", id: "pending" }));
      await waitUntil(() => started);
      stopping = host.stop();
      await expect(stopping).rejects.toThrow("WebSocket shutdown timed out");
      expect(host.port).toBe(-1);
      expect(order).toEqual([]);
      // A cleared port field alone does not prove the native listener stopped.
      const connectionError = await new Promise<string | undefined>((resolve, reject) => {
        const probe = createConnection({ host: "127.0.0.1", port });
        probe.once("connect", () => { probe.destroy(); reject(new Error("HTTP listener remained open")); });
        probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code));
        probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("Listener closure probe timed out")); });
      });
      expect(connectionError).toBe("ECONNREFUSED");
    } finally {
      release();
      ws?.close();
      if (stopping) await stopping.catch(() => {}); // Already asserted as this test's expected failure.
      else await host.stop();
      await waitUntil(() => order.includes("gateway"));
      await isolated.dispose();
    }
    expect(order).toEqual(["handler", "gateway"]);
  });

  test("messages on one connection execute sequentially", async () => {
    const ws = await connect();
    const first = request(ws, { type: "event", event: "slow", data: 1, id: "slow-1" }, (p) => p.id === "slow-1");
    const second = request(ws, { type: "event", event: "slow", data: 2, id: "slow-2" }, (p) => p.id === "slow-2");

    const [firstAck, secondAck] = await Promise.all([first, second]);
    expect(firstAck.data).toBe(1);
    expect(secondAck.data).toBe(2);
    expect(gateway.maxConcurrentSlowHandlers).toBe(1);
    ws.close();
  });

  test("ingress and control frames are rate limited before handler dispatch", async () => {
    const ingress = await connect();
    await request(ingress, { type: "event", event: "echo", id: "i1" }, (p) => p.id === "i1");
    await request(ingress, { type: "event", event: "echo", id: "i2" }, (p) => p.id === "i2");
    const ingressBlocked = await request(
      ingress,
      { type: "event", event: "echo", id: "i3" },
      (p) => p.type === "error",
    );
    expect(ingressBlocked.data).toMatchObject({ message: "Too many messages" });

    const control = await connect();
    await request(control, { type: "ping" }, (p) => p.type === "pong");
    const controlBlocked = await request(control, { type: "ping", id: "p2" }, (p) => p.id === "p2");
    expect(controlBlocked.data).toMatchObject({ message: "Too many control frames" });
    ingress.close();
    control.close();
  });

  test("ping is answered with pong", async () => {
    const ws = await connect();
    const pong = await request(ws, { type: "ping" }, (p) => p.type === "pong");
    expect(pong.type).toBe("pong");
    ws.close();
  });

  test("reconnect by sid restores the session and its rooms", async () => {
    const { ws: first, sid } = await connectFull();
    expect(sid).not.toBe("");

    const joined = await request(first, { type: "event", event: "join", data: "vip", id: "j" }, (p) => p.id === "j");
    expect(joined.data).toEqual({ joined: "vip" });

    first.close();
    await Bun.sleep(10);

    // Reconnect carrying the session id; expect a "reconnected" frame with the same sid.
    const frame = await new Promise<ServerPacket>((resolve) => {
      const ws = new WebSocket(`${base}?sid=${sid}`);
      ws.addEventListener("message", (event) => {
        const packet = JSON.parse(String(event.data)) as ServerPacket;
        if (packet.type === "reconnected") {
          resolve(packet);
        }
      });
    });
    expect(frame.sid).toBe(sid);
  });

  test("a SID has one active physical connection and replacement cannot be cleared by the old socket", async () => {
    const { ws: first, sid } = await connectFull();
    const firstClosed = new Promise<CloseEvent>((resolve) => {
      first.addEventListener("close", resolve, { once: true });
    });

    const replacement = await reconnectFull(sid);
    expect(replacement.frame.sid).toBe(sid);
    expect((await firstClosed).code).toBe(4009);
    await Bun.sleep(45);

    const ack = await request(
      replacement.ws,
      { type: "event", event: "echo", data: "still-owner", id: "owner" },
      (packet) => packet.id === "owner",
    );
    expect(ack.data).toEqual({ echoed: "still-owner" });
    replacement.ws.close();
  });

  test("control reconnect detaches old rooms and leaves the old SID reconnectable", async () => {
    const { ws: rebound, sid: oldSid } = await connectFull();
    await request(rebound, { type: "event", event: "join", data: "old-room", id: "old-join" }, (p) => p.id === "old-join");

    const { ws: target, sid: targetSid } = await connectFull();
    await new Promise<void>((resolve) => {
      target.addEventListener("close", () => resolve(), { once: true });
      target.close();
    });
    await Bun.sleep(2);

    const reboundFrame = await request(
      rebound,
      { type: "reconnect", data: { sid: targetSid }, id: "move" },
      (packet) => packet.type === "reconnected",
    );
    expect(reboundFrame.sid).toBe(targetSid);

    const restored = await reconnectFull(oldSid);
    const sender = await connect();
    await request(sender, { type: "event", event: "join", data: "old-room", id: "sender-join" }, (p) => p.id === "sender-join");

    let reboundReceivedOldRoom = false;
    rebound.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as ServerPacket;
      if (packet.type === "event" && packet.event === "message") {
        reboundReceivedOldRoom = true;
      }
    });
    const restoredMessage = new Promise<ServerPacket>((resolve) => {
      restored.ws.addEventListener("message", (event) => {
        const packet = JSON.parse(String(event.data)) as ServerPacket;
        if (packet.type === "event" && packet.event === "message") {
          resolve(packet);
        }
      });
    });
    sender.send(JSON.stringify({
      v: 1,
      type: "event",
      event: "broadcast",
      data: { room: "old-room", text: "old-only" },
    }));

    expect((await restoredMessage).data).toBe("old-only");
    await Bun.sleep(5);
    expect(reboundReceivedOldRoom).toBe(false);
    rebound.close();
    restored.ws.close();
    sender.close();
  });

  test("control reconnect cannot steal a session principal established by gateway middleware", async () => {
    const connectAs = (user: string): Promise<{ ws: WebSocket; sid: string }> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${server.port}/ws/custom-auth?user=${encodeURIComponent(user)}`);
        ws.addEventListener("error", reject, { once: true });
        ws.addEventListener("message", (event) => {
          const packet = JSON.parse(String(event.data)) as ServerPacket;
          if (packet.type === "connected") {
            resolve({ ws, sid: packet.sid ?? "" });
          }
        });
      });

    const alice = await connectAs("alice");
    const bob = await connectAs("bob");
    const denied = await request(
      bob.ws,
      { type: "reconnect", data: { sid: alice.sid }, id: "steal" },
      (packet) => packet.type === "error" && packet.id === "steal",
    );

    expect(denied.data).toEqual({ message: "Unauthorized reconnect" });
    alice.ws.close();
    bob.ws.close();
  });

  test("a namespace enforces its own inbound payload limit", async () => {
    const tinyBase = base.replace("/ws/chat", "/ws/tiny");
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(tinyBase);
      socket.addEventListener("error", reject, { once: true });
      socket.addEventListener("message", (event) => {
        const packet = JSON.parse(String(event.data)) as ServerPacket;
        if (packet.type === "connected") {
          resolve(socket);
        }
      });
    });
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }));
    ws.send(JSON.stringify({ v: 1, type: "event", event: "echo", data: "x".repeat(512), id: "large" }));
    expect((await closed).code).toBe(1009);
  });

  test("a namespace enforces its own outbound payload limit", async () => {
    const tinyBase = base.replace("/ws/chat", "/ws/tiny");
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(tinyBase);
      socket.addEventListener("error", reject, { once: true });
      socket.addEventListener("message", (event) => {
        const packet = JSON.parse(String(event.data)) as ServerPacket;
        if (packet.type === "connected") {
          resolve(socket);
        }
      });
    });
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve, { once: true }));
    ws.send(JSON.stringify({ v: 1, type: "event", event: "large-response", id: "large-response" }));
    expect((await closed).code).toBe(1009);
  });

  test("messages broadcast while offline are replayed on reconnect", async () => {
    const a = await connect();
    const { ws: b, sid } = await connectFull();

    await request(a, { type: "event", event: "join", data: "room9", id: "ja" }, (p) => p.id === "ja");
    await request(b, { type: "event", event: "join", data: "room9", id: "jb" }, (p) => p.id === "jb");

    // B goes offline; give the server a tick to process the close.
    b.close();
    await Bun.sleep(20);

    a.send(JSON.stringify({ v: 1, type: "event", event: "broadcast", data: { room: "room9", text: "while-away" } }));
    await Bun.sleep(10);

    // B reconnects and the reconnected frame replays the missed broadcast.
    const frame = await new Promise<ServerPacket>((resolve) => {
      const ws = new WebSocket(`${base}?sid=${sid}`);
      ws.addEventListener("message", (event) => {
        const packet = JSON.parse(String(event.data)) as ServerPacket;
        if (packet.type === "reconnected") {
          resolve(packet);
        }
      });
    });

    expect(frame.missed?.some((m) => m.event === "message" && m.data === "while-away")).toBe(true);
    a.close();
  });

  test("room broadcast reaches another socket but not the sender", async () => {
    const a = await connect();
    const b = await connect();

    await request(a, { type: "event", event: "join", data: "room1", id: "j1" }, (p) => p.id === "j1");
    await request(b, { type: "event", event: "join", data: "room1", id: "j2" }, (p) => p.id === "j2");

    const received = new Promise<ServerPacket>((resolve) => {
      b.addEventListener("message", (event) => {
        const packet = JSON.parse(String(event.data)) as ServerPacket;
        if (packet.type === "event" && packet.event === "message") {
          resolve(packet);
        }
      });
    });

    // The sender must NOT receive its own broadcast.
    let senderGotMessage = false;
    a.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as ServerPacket;
      if (packet.type === "event" && packet.event === "message") {
        senderGotMessage = true;
      }
    });

    a.send(JSON.stringify({ v: 1, type: "event", event: "broadcast", data: { room: "room1", text: "hello" } }));

    const message = await received;
    expect(message.data).toBe("hello");
    expect(senderGotMessage).toBe(false);

    a.close();
    b.close();
  });
});
