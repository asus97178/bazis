import type { Server, ServerWebSocket } from "bun";
import { WebSocketServer, type WebSocketServerOptions, type WsConnectionData } from "../ws-server";
import type { RegisteredNamespace, CompiledWsHandler } from "../explorer";
import type { ClientPacket, ServerPacket } from "../types";
import { jsonPacketCodec } from "../codec/json.codec";

export function testNamespace(overrides: Partial<RegisteredNamespace> = {}): RegisteredNamespace {
  return { namespace: "/reliability", path: "/ws/reliability", gatewayInstance: {}, handlers: new Map(),
    middleware: [], corsOrigins: [], maxPayloadBytes: 65_536, sessionTtlMs: 60_000, ...overrides };
}

export function testHandler(event: string, method: (...args: any[]) => unknown): CompiledWsHandler {
  return { events: [event], handlerName: event, handler: method, arity: method.length };
}

export async function startWebSocketFixture(options: WebSocketServerOptions) {
  const runtime = new WebSocketServer(options);
  const codec = options.codec ?? jsonPacketCodec;
  await runtime.initialize();
  const callbacks = runtime.createBunHandler();
  const nativeSockets = new Set<ServerWebSocket<WsConnectionData>>();
  const nativeStats = { opens: 0, closes: 0, drains: 0, sent: 0, backpressure: 0, dropped: 0, peakBuffered: 0,
    closeReasons: [] as string[], drainBuffers: [] as Array<{ immediate: number; nextTick?: number }> };
  let listener: Server<WsConnectionData>;
  try {
    listener = Bun.serve<WsConnectionData>({ hostname: "127.0.0.1", port: 0,
      fetch: async (request, server) => {
        const response = await runtime.tryUpgrade(request, server);
        // Bun's successful upgrade intentionally returns no HTTP response.
        return response === undefined ? undefined as unknown as Response : response ?? new Response("Not found", { status: 404 });
      }, websocket: { ...callbacks,
        open(ws) {
          const nativeSend = ws.send.bind(ws);
          ws.send = (data, compress) => {
            const result = nativeSend(data, compress);
            if (result === -1) nativeStats.backpressure++; else if (result === 0) nativeStats.dropped++; else nativeStats.sent++;
            nativeStats.peakBuffered = Math.max(nativeStats.peakBuffered, ws.getBufferedAmount());
            return result;
          };
          nativeSockets.add(ws); nativeStats.opens++; callbacks.open?.(ws);
        },
        close(ws, code, reason) {
          nativeStats.closes++; nativeStats.closeReasons.push(`${code}:${reason}`);
          if (nativeStats.closeReasons.length > 32) nativeStats.closeReasons.shift();
          nativeSockets.delete(ws); callbacks.close?.(ws, code, reason);
        },
        drain(ws) {
          const sample = { immediate: ws.getBufferedAmount(), nextTick: undefined as number | undefined };
          nativeStats.drainBuffers.push(sample); if (nativeStats.drainBuffers.length > 32) nativeStats.drainBuffers.shift();
          nativeStats.drains++; callbacks.drain?.(ws);
          setImmediate(() => { sample.nextTick = ws.getBufferedAmount(); });
        },
      } });
  } catch (error) { await runtime.close(); throw error; }
  const peers = new Set<WebSocket>();
  const url = `ws://127.0.0.1:${listener.port}${options.namespaces[0]!.path}`;
  return { runtime, listener, url, nativeSockets, nativeStats,
    async connect(query = "") {
      const ws = new WebSocket(url + query);
      ws.binaryType = "arraybuffer";
      peers.add(ws);
      const frames: ServerPacket[] = [];
      let error: unknown;
      let closed = false;
      ws.onmessage = (event) => frames.push(decodeServerPacket(event.data));
      ws.onerror = (event) => { error = event; };
      ws.onclose = () => { closed = true; peers.delete(ws); };
      await until(() => frames.length > 0 || closed || error !== undefined);
      if (error || closed) throw new Error("Test WebSocket did not initialize.");
      return { ws, frames,
        send(packet: Omit<ClientPacket, "v"> & { v?: 1 }) { ws.send(codec.encodeClient(packet)); },
        async close() { ws.close(); await until(() => closed); },
      };
    },
    async close() {
      for (const peer of peers) peer.close();
      try { await runtime.close(); } finally { listener.stop(true); }
    },
  };
}

export function decodeServerPacket(raw: string | ArrayBuffer | Uint8Array): ServerPacket {
  if (typeof raw === "string") return JSON.parse(raw) as ServerPacket;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return JSON.parse(new TextDecoder().decode(bytes[0] === 1 ? bytes.subarray(5) : bytes)) as ServerPacket;
}

export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 2500): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error("WebSocket test condition timed out.");
    await Bun.sleep(2);
  }
}
