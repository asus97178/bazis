import type { ServerWebSocket } from "bun";
import type { OsnvSocket, ReplayDelivery, ServerPacket, SocketBroadcast, SocketContext, SocketUser } from "./types";
import type { PacketCodec } from "./codec/packet-codec.interface";
import { payloadToBytes } from "./codec/packet-codec.interface";
import type { TopicCache } from "./topic-cache";
import { WebSocketDeliveryError, type ReliableBroadcastOptions, type ReliableBroadcastReceipt } from "./reliable-delivery";

/** A server frame minus the wire version (filled in by the codec). */
export type OutgoingPacket = Omit<ServerPacket, "v"> & { v?: 1 };

export interface WsConnectionData {
  sid: string;
  connId: string;
  namespace: string;
  context: SocketContext;
  rooms: Set<string>;
  isReconnect?: boolean;
  /** Runtime bookkeeping; not part of the public socket context. */
  opened?: boolean;
  closed?: boolean;
  /** Fail-closed after a message deadline so queued handlers cannot continue. */
  messageProcessingStopped?: boolean;
  /** Immutable authentication authority for reconnect ownership checks. */
  principal?: SocketUser;
  /** Aborts socket-owned lifecycle effects once the physical connection closes. */
  lifetimeController: AbortController;
  replayDelivery?: ReplayDelivery;
  /** Bounded by replay queue size; receipts are valid only on the issuing connection. */
  sentReplayIds?: Set<string>;
  sentReliableIds?: Set<string>;
  recentReliableAcks?: Set<string>;
  replaying?: boolean;
}

export interface WrapSocketOptions {
  codec: PacketCodec;
  /** Per-message cancellation. Omitted for lifecycle hooks. */
  signal?: AbortSignal;
  send: (payload: string | Uint8Array) => void;
  maxRoomNameLength?: number;
  maxRoomsPerSession?: number;
  /**
   * Fan-out to a room, excluding the originating socket (Socket.IO `to()`
   * semantics). Local delivery uses `ws.publish`, the adapter handles other
   * nodes, and offline members of the room are queued for reconnect replay.
   */
  broadcast: (room: string, packet: OutgoingPacket) => void;
  broadcastReliable?: (room: string, packet: OutgoingPacket, options: ReliableBroadcastOptions) => Promise<ReliableBroadcastReceipt>;
  disconnect?: (code: number, reason: string) => void;
  onRoomsChanged?: (sid: string, rooms: ReadonlySet<string>) => void;
}

class SocketBroadcastImpl implements SocketBroadcast {
  constructor(
    private readonly namespace: string,
    private readonly room: string,
    private readonly broadcast: WrapSocketOptions["broadcast"],
    private readonly signal?: AbortSignal,
    private readonly reliable?: WrapSocketOptions["broadcastReliable"],
  ) {}

  emit(event: string, data?: unknown): void {
    if (this.signal?.aborted) {
      return;
    }
    this.broadcast(this.room, { type: "event", namespace: this.namespace, event, data });
  }

  async emitReliable(event: string, data: unknown, options: ReliableBroadcastOptions): Promise<ReliableBroadcastReceipt> {
    this.signal?.throwIfAborted();
    if (!this.reliable) throw new WebSocketDeliveryError("RELIABLE_DELIVERY_UNAVAILABLE");
    return this.reliable(this.room, { type: "event", namespace: this.namespace, event, data }, options);
  }
}

export class OsnvSocketImpl implements OsnvSocket {
  private dataTarget?: SocketContext;
  private dataProxy?: SocketContext;
  private dataProxyCache?: WeakMap<object, object>;

  constructor(
    private readonly ws: ServerWebSocket<WsConnectionData>,
    private readonly topics: TopicCache,
    private readonly options: WrapSocketOptions,
  ) {}

  get id(): string {
    return this.ws.data.sid;
  }

  get connId(): string {
    return this.ws.data.connId;
  }

  get namespace(): string {
    return this.ws.data.namespace;
  }

  get data(): SocketContext {
    const context = this.ws.data.context;
    if (!this.options.signal) {
      return context;
    }
    if (this.dataTarget !== context || !this.dataProxy) {
      const signal = this.options.signal;
      this.dataTarget = context;
      this.dataProxyCache = new WeakMap<object, object>();
      this.dataProxy = abortAwareProxy(context, signal, this.dataProxyCache);
    }
    return this.dataProxy;
  }

  get rooms(): ReadonlySet<string> {
    // ReadonlySet is a compile-time contract only; exposing the live Set lets
    // plain JavaScript (or a cast) bypass join/leave, persistence and abort.
    return new Set(this.ws.data.rooms);
  }

  get signal(): AbortSignal | undefined {
    return this.options.signal;
  }

  emit(event: string, data?: unknown): void {
    if (this.options.signal?.aborted) {
      return;
    }
    const payload = this.options.codec.encodeServer({
      type: "event",
      namespace: this.namespace,
      event,
      data,
    });
    this.options.send(payload);
  }

  to(room: string): SocketBroadcast {
    assertRoomName(room, this.options.maxRoomNameLength);
    return new SocketBroadcastImpl(this.namespace, room, this.options.broadcast, this.options.signal, this.options.broadcastReliable);
  }

  in(room: string): SocketBroadcast {
    return this.to(room);
  }

  join(room: string): void {
    if (this.options.signal?.aborted) {
      return;
    }
    assertRoomName(room, this.options.maxRoomNameLength);
    const maxRooms = this.options.maxRoomsPerSession ?? 256;
    if (!this.ws.data.rooms.has(room) && this.ws.data.rooms.size >= maxRooms) {
      throw new Error(`WebSocket room limit exceeded (${maxRooms}).`);
    }
    const topic = this.topics.get(this.namespace, room);
    this.ws.subscribe(topic);
    this.ws.data.rooms.add(room);
    this.options.onRoomsChanged?.(this.ws.data.sid, this.ws.data.rooms);
  }

  leave(room: string): void {
    if (this.options.signal?.aborted) {
      return;
    }
    assertRoomName(room, this.options.maxRoomNameLength);
    const topic = this.topics.get(this.namespace, room);
    this.ws.unsubscribe(topic);
    this.ws.data.rooms.delete(room);
    this.topics.delete(this.namespace, room);
    this.options.onRoomsChanged?.(this.ws.data.sid, this.ws.data.rooms);
  }

  disconnect(code = 1000, reason = "server disconnect"): void {
    if (this.options.signal?.aborted) {
      return;
    }
    if (this.options.disconnect) this.options.disconnect(code, reason);
    else this.ws.close(code, reason);
  }
}

export function wrapSocket(
  ws: ServerWebSocket<WsConnectionData>,
  topics: TopicCache,
  options: WrapSocketOptions,
): OsnvSocket {
  return new OsnvSocketImpl(ws, topics, options);
}

export function createConnectionData(
  namespace: string,
  context: SocketContext,
  sid: string = crypto.randomUUID(),
  replayDelivery: ReplayDelivery = "transport",
): WsConnectionData {
  return {
    sid,
    connId: crypto.randomUUID(),
    namespace,
    context: cloneSocketContext(context),
    principal: cloneSocketUser(context.user),
    lifetimeController: new AbortController(),
    rooms: new Set<string>(),
    replayDelivery,
  };
}

export function restoreRoomSubscriptions(
  ws: ServerWebSocket<WsConnectionData>,
  topics: TopicCache,
): void {
  for (const room of ws.data.rooms) {
    ws.subscribe(topics.get(ws.data.namespace, room));
  }
}

/** Removes subscriptions owned by the connection before rebinding its SID. */
export function detachRoomSubscriptions(
  ws: ServerWebSocket<WsConnectionData>,
  topics: TopicCache,
): void {
  for (const room of ws.data.rooms) {
    ws.unsubscribe(topics.get(ws.data.namespace, room));
  }
}

export function applySessionToConnection(
  ws: ServerWebSocket<WsConnectionData>,
  sid: string,
  context: SocketContext,
  rooms: string[],
): void {
  ws.data.sid = sid;
  ws.data.context = cloneSocketContext(context);
  ws.data.rooms = new Set(rooms);
  ws.data.isReconnect = true;
  ws.data.sentReplayIds = undefined;
  ws.data.sentReliableIds = undefined;
  ws.data.recentReliableAcks = undefined;
}

function cloneSocketContext(context: SocketContext): SocketContext {
  return {
    ...context,
    ...(context.user ? { user: cloneSocketUser(context.user) } : {}),
  };
}

function cloneSocketUser(user: SocketUser | undefined): SocketUser | undefined {
  return user ? { ...user } : undefined;
}

function abortAwareProxy<T extends object>(
  value: T,
  signal: AbortSignal,
  cache: WeakMap<object, object>,
): T {
  const cached = cache.get(value);
  if (cached) {
    return cached as T;
  }
  const proxy = new Proxy(value, {
    get: (target, property, receiver) => {
      const nested = Reflect.get(target, property, receiver) as unknown;
      return isPlainMutableObject(nested)
        ? abortAwareProxy(nested, signal, cache)
        : nested;
    },
    set: (target, property, next, receiver) =>
      signal.aborted ? true : Reflect.set(target, property, next, receiver),
    deleteProperty: (target, property) =>
      signal.aborted ? true : Reflect.deleteProperty(target, property),
    defineProperty: (target, property, descriptor) =>
      signal.aborted ? true : Reflect.defineProperty(target, property, descriptor),
    setPrototypeOf: (target, prototype) =>
      signal.aborted ? true : Reflect.setPrototypeOf(target, prototype),
  });
  cache.set(value, proxy);
  return proxy;
}

function isPlainMutableObject(value: unknown): value is object {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

export function sendPayload(
  ws: ServerWebSocket<WsConnectionData>,
  payload: string | Uint8Array,
): void {
  trySendPayload(ws, payload);
}

/** Internal acceptance check: Bun's -1 is queued backpressure, 0 is a drop. */
export function trySendPayload(
  ws: ServerWebSocket<WsConnectionData>,
  payload: string | Uint8Array,
): boolean {
  return ws.send(typeof payload === "string" ? payload : payloadToBytes(payload)) !== 0;
}

function assertRoomName(room: string, maxLength = 256): void {
  if (room.length === 0) {
    throw new Error("WebSocket room name must not be empty.");
  }
  if (room.length > maxLength) {
    throw new Error(`WebSocket room name exceeds ${maxLength} characters.`);
  }
  if (room.includes("\0")) {
    throw new Error("WebSocket room name contains an invalid separator.");
  }
}
