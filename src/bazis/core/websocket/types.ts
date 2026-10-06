import type { ReliableBroadcastOptions, ReliableBroadcastReceipt } from "./reliable-delivery";

/**
 * WebSocket wire protocol (v1) and the public `BazisSocket` surface.
 * Self-contained: no framework runtime types leak into the wire format.
 */

export type ReplayDelivery = "transport" | "client-ack";

export interface ReplayAcknowledgement {
  /** UUIDs actually received on this physical connection; acknowledge after processing. */
  deliveryIds: string[];
}

export interface ClientPacket {
  v: 1;
  type: "event" | "reconnect" | "ping" | "replay-ack";
  namespace?: string;
  event?: string;
  data?: unknown;
  /** Correlation id for acknowledgements. */
  id?: string;
}

export interface ServerPacket {
  v: 1;
  type: "event" | "ack" | "connected" | "reconnected" | "error" | "pong";
  namespace?: string;
  event?: string;
  data?: unknown;
  /** Echoes the client packet id on ack/error. */
  id?: string;
  /** Session id, sent on connected/reconnected. */
  sid?: string;
  /** Replay prefix in reconnected; overflow follows as ordinary packets. */
  missed?: ServerPacket[];
  /** Stable replay identity, separate from request/response correlation id. */
  deliveryId?: string;
  /** Negotiated replay semantics, advertised by connected/reconnected. */
  replayDelivery?: ReplayDelivery;
  /** Number of replay packets in this reconnect, including subsequent event frames. */
  replayCount?: number;
}

export interface ReconnectPacketData {
  sid?: string;
  token?: string;
}

/** Authenticated principal attached at upgrade. */
export interface SocketUser {
  readonly id: string;
  readonly [key: string]: unknown;
}

/** Per-connection state available to gateways (user + custom upgrade data). */
export interface SocketContext {
  user?: SocketUser;
  [key: string]: unknown;
}

/**
 * Completes the packet's single acknowledgement using the selected codec.
 * A handler declaring this third parameter and returning undefined waits for
 * the callback within messageHandlingTimeoutMs. Ignored without a packet id,
 * after cancellation, or after a return value/callback already replied.
 */
export type AckCallback = (response?: unknown, error?: { message: string; code?: string }) => void;

/** Chainable broadcast target: `socket.to(room).emit(...)`. */
export interface SocketBroadcast {
  emit(event: string, data?: unknown): void;
  emitReliable(event: string, data: unknown, options: ReliableBroadcastOptions): Promise<ReliableBroadcastReceipt>;
}

/**
 * Stable gateway-facing socket API (we never expose Bun's `ServerWebSocket`).
 * `id` is the session id (stable across reconnects); `connId` is the physical
 * connection.
 */
export interface BazisSocket {
  readonly id: string;
  readonly connId: string;
  readonly namespace: string;
  readonly data: SocketContext;
  readonly rooms: ReadonlySet<string>;
  /** Aborted when the current message is cancelled or exceeds its deadline. */
  readonly signal?: AbortSignal;
  emit(event: string, data?: unknown): void;
  to(room: string): SocketBroadcast;
  in(room: string): SocketBroadcast;
  join(room: string): void;
  leave(room: string): void;
  disconnect(code?: number, reason?: string): void;
}

/** Gateway lifecycle hooks (all optional, duck-typed at runtime). */
export interface OnGatewayInit {
  onGatewayInit?(): void | Promise<void>;
}
export interface OnGatewayConnection {
  handleConnection?(socket: BazisSocket): void | Promise<void>;
}
export interface OnGatewayDisconnect {
  handleDisconnect?(socket: BazisSocket, reason: string): void | Promise<void>;
}
export interface OnGatewayShutdown {
  onGatewayShutdown?(): void | Promise<void>;
}

export function hasOnGatewayInit(value: unknown): value is Required<OnGatewayInit> {
  return typeof (value as OnGatewayInit | null)?.onGatewayInit === "function";
}
export function hasHandleConnection(value: unknown): value is Required<OnGatewayConnection> {
  return typeof (value as OnGatewayConnection | null)?.handleConnection === "function";
}
export function hasHandleDisconnect(value: unknown): value is Required<OnGatewayDisconnect> {
  return typeof (value as OnGatewayDisconnect | null)?.handleDisconnect === "function";
}
export function hasOnGatewayShutdown(value: unknown): value is Required<OnGatewayShutdown> {
  return typeof (value as OnGatewayShutdown | null)?.onGatewayShutdown === "function";
}
