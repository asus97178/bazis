import { describe, expect, test } from "bun:test";
import { DI, Module, singleton } from "@/core/di";
import { startTestApp, type TestApp } from "@/core/testing";
import { InMemoryWebSocketAdapter, SubscribeMessage, WebSocketGateway, type BazisSocket, type WebSocketAdapter } from "@/core/websocket";

// 0.100.4: runApp({ websocket }) builds the adapter from the application's
// services and gives the token check those services, so a Redis adapter can
// use the @Infra client and the check can use the application's token service.

/** The application's token service: a provider, not a module-level constant. */
class Tokens {
  verify(token: string | null): { id: string } | null {
    return token === "ann-token" ? { id: "ann" } : null;
  }
}

/** Something the adapter factory takes from DI, as RedisWebSocketAdapter takes IRedis. */
class AdapterSource {
  readonly adapters: WebSocketAdapter[] = [];
  create(): WebSocketAdapter {
    const adapter = new InMemoryWebSocketAdapter();
    this.adapters.push(adapter);
    return adapter;
  }
}

@WebSocketGateway({ namespace: "chat" })
class ChatGateway {
  @SubscribeMessage("whoami")
  whoami(socket: BazisSocket) { return socket.data.user ?? null; }
}

DI.bindDeps(ChatGateway);

@Module({ gateways: [ChatGateway], providers: [singleton(Tokens), singleton(AdapterSource)], exports: [Tokens, AdapterSource] })
class ChatModule {}

function start(): Promise<TestApp> {
  return startTestApp(ChatModule, {
    http: {},
    websocket: {
      requireAuth: true,
      cors: { origins: ["http://localhost"] },
      adapter: (services) => services.resolve(AdapterSource).create(),
      authenticator: (token, context) => context!.services!.resolve(Tokens).verify(token),
    },
  });
}

async function open(app: TestApp, token: string): Promise<{ ws: WebSocket; connected: Promise<unknown> }> {
  const ws = new WebSocket(`${app.url.replace("http", "ws")}/ws/chat`, [`bearer.${token}`]);
  const connected = new Promise((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("refused")), { once: true });
    ws.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as { type: string; data?: unknown };
      if (packet.type === "connected") resolve(packet.data);
    });
  });
  return { ws, connected };
}

describe("websocket options built from the application's services", () => {
  test("the adapter comes from DI and the token check uses an application service", async () => {
    const app = await start();
    try {
      expect(app.container.resolve(AdapterSource).adapters).toHaveLength(1);
      const ann = await open(app, "ann-token");
      expect(await ann.connected).toEqual({ userId: "ann" });
      ann.ws.close();
      const stranger = await open(app, "wrong");
      await expect(stranger.connected).rejects.toThrow("refused");
    } finally {
      await app.stop();
    }
  });

  test("a ready adapter instance is refused with the way to build one", async () => {
    await expect(startTestApp(ChatModule, {
      http: {},
      websocket: { adapter: new InMemoryWebSocketAdapter() as never },
    })).rejects.toThrow("websocket.adapter must be a function of the application services");
  });
});
