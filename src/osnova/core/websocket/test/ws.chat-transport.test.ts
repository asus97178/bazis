import { afterEach, expect, test } from "bun:test";
import { createContainer, Module, type DiContainer } from "@/core/di";
import { WEBSOCKET_UPGRADE, type WebSocketUpgrade } from "@/core/http";
import { resolveWebSocketGatewayOptions, SubscribeMessage, WebSocketGateway, websocketModule, WsUpgradeError } from "@/core/websocket";

@WebSocketGateway({ namespace: "/bounded", maxPayloadBytes: 256, maxOutboundPayloadBytes: 4096 })
class BoundedGateway {
  calls = 0;
  @SubscribeMessage("large") large() { this.calls++; return "x".repeat(2048); }
}
let container: DiContainer | undefined, upgrade: WebSocketUpgrade | undefined, server: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { await upgrade?.close(); server?.stop(true); await container?.dispose(); });

test("outbound bound is optional, independent, and positive", () => {
  expect(resolveWebSocketGatewayOptions({ maxPayloadBytes: 256 }).maxOutboundPayloadBytes).toBe(256);
  expect(() => resolveWebSocketGatewayOptions({ maxOutboundPayloadBytes: 0 })).toThrow(/maxOutbound/);
});
test("DI upgrade policy and different ingress/egress bounds work on the actual listener", async () => {
  let called = 0;
  @Module({ imports: [websocketModule({ gateways: [BoundedGateway], middlewareFactory: services => {
    expect(services.resolve(BoundedGateway)).toBeInstanceOf(BoundedGateway);
    return async (ctx, next) => { called++; if (ctx.request.headers.get("origin") !== "http://allowed.test") throw new WsUpgradeError("Forbidden"); await next(); };
  } })] }) class Root {}
  container = createContainer(Root); upgrade = container.resolve(WEBSOCKET_UPGRADE); await upgrade.initialize();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: upgrade.createBunHandler(),
    async fetch(request, native) { const result = await upgrade!.tryUpgrade(request, native); return result === null ? new Response("Not found", { status: 404 }) : result; } });
  const url = `ws://127.0.0.1:${server.port}/ws/bounded`;
  const refused = new WebSocket(url);
  await new Promise<void>(resolve => { refused.onerror = () => resolve(); });
  const socket = new WebSocket(url, { headers: { origin: "http://allowed.test" } });
  const packets: any[] = [];
  socket.onmessage = event => packets.push(JSON.parse(String(event.data)));
  for (let i = 0; i < 100 && !packets.length; i++) await Bun.sleep(5);
  socket.send(JSON.stringify({ v: 1, type: "event", event: "large", id: "one" }));
  for (let i = 0; i < 100 && !packets.some(packet => packet.id === "one"); i++) await Bun.sleep(5);
  expect(packets.find(packet => packet.id === "one")?.data).toHaveLength(2048);
  const closed = new Promise<number>(resolve => { socket.onclose = event => resolve(event.code); });
  socket.send(JSON.stringify({ v: 1, type: "event", event: "large", data: "x".repeat(300) }));
  // Bun may terminate an oversized native frame without a close handshake (1006).
  expect([1006, 1009]).toContain(await closed);
  expect(container.resolve(BoundedGateway).calls).toBe(1); expect(called).toBe(2);
}, 10_000);
