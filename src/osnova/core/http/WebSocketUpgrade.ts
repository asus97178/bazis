import type { Server, WebSocketHandler } from "bun";
import { createToken } from "../di";

/**
 * Port for sharing the HTTP listener with a WebSocket runtime (DIP): the HTTP
 * module owns the `Bun.serve` loop and only knows this interface, while the
 * `websocket` module provides the implementation. This keeps `@/core/http`
 * free of any WebSocket imports.
 *
 * Contract of {@link tryUpgrade}:
 * - `null`     — not a WebSocket request for us; continue normal HTTP handling.
 * - `undefined`— the connection was upgraded; return nothing to Bun.
 * - `Response` — reject the handshake with this response (e.g. 401/403).
 */
export interface WebSocketUpgrade {
  /** Runs once before serving (adapter wiring, gateway `onGatewayInit`). */
  initialize(): void | Promise<void>;
  // The concrete connection-data generic lives in the websocket module; the
  // HTTP layer stays agnostic, so `any` is used deliberately here.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  tryUpgrade(request: Request, server: Server<any>): Promise<Response | undefined | null>;
  /** The handler passed to `Bun.serve({ websocket })`. */
  createBunHandler(): WebSocketHandler<any>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  close(): void | Promise<void>;
}

/** Optional: when registered, {@link HttpServer} shares its port for upgrades. */
export const WEBSOCKET_UPGRADE = createToken<WebSocketUpgrade>("OsnovaWebSocketUpgrade");
