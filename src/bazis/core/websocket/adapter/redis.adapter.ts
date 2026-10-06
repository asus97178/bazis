import type { RedisClient } from "bun";
import type { SessionState } from "../session-manager";
import { createInstanceId, type WebSocketAdapter, type WebSocketAdapterHooks } from "./adapter.interface";
import { RedisWebSocketOperations } from "./redis-operations";
import { RedisRoomDeliveryStore, type RedisReliableDeliveryOptions } from "./redis-delivery-store";
import { KEYS, UPDATE_ROOMS, DELETE_ROOMS } from "./redis-delivery-scripts";

export interface RedisWebSocketAdapterOptions {
  /** Optional host-owned command client isolating delivery from session I/O; same logical store required. */
  readonly deliveryClient?: RedisClient;
  /** Shared by the nodes of one application; isolate unrelated applications. */
  readonly keyPrefix?: string;
  /** Initial-write/deletion protection window, milliseconds. Default 60,000. */
  readonly writeProtectionMs?: number;
  /** Maximum encoded session record. Default 8 MiB. */
  readonly maxSessionBytes?: number;
  /** Maximum pub/sub packet bytes. Default 1 MiB. */
  readonly maxPublishBytes?: number;
  readonly operationTimeoutMs?: number;
  readonly maxPendingOperations?: number;
  readonly reliable?: RedisReliableDeliveryOptions;
}

// One Redis key per SID. The record survives until both reconnect TTL and the
// initial-write window have elapsed. Expiring a key can therefore never make an
// old snapshot eligible for an initial write again. All revision checks and
// writes execute atomically in the same Lua invocation.
const SAVE = KEYS + `
local raw = redis.call('GET', KEYS[1])
local next = cjson.decode(ARGV[1])
local expected = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if raw then
  local current = cjson.decode(raw)
  if current.deleted or next.revision <= current.revision then return 0 end
  if expected >= 0 and expected ~= current.revision then return 0 end
  if next.createdAt ~= current.createdAt or next.creationToken ~= current.creationToken then return 0 end
else
  if expected > 0 or next.revision ~= 1 then return 0 end
  if next.createdAt <= now - window or next.createdAt > now + 1000 then return 0 end
end
local ttl = math.ceil(math.max(next.expiresAt, next.createdAt + window) - now)
if ttl <= 0 then return 0 end
${UPDATE_ROOMS}
redis.call('SET', KEYS[1], cjson.encode({revision=next.revision, createdAt=next.createdAt, creationToken=next.creationToken, state=ARGV[1]}), 'PX', ttl)
return 1
`;

const DELETE = KEYS + `
local raw = redis.call('GET', KEYS[1])
local current = raw and cjson.decode(raw) or nil
local revision = tonumber(ARGV[1])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if current and revision >= 0 and revision < current.revision then return 0 end
if revision < 0 then revision = current and current.revision + 1 or 1 end
${DELETE_ROOMS}
local created = current and current.createdAt or now
local ttl = math.ceil(created + tonumber(ARGV[2]) - now)
if ttl <= 0 then redis.call('DEL', KEYS[1]); return 1 end
redis.call('SET', KEYS[1], cjson.encode({revision=revision, createdAt=created, deleted=true}), 'PX', ttl)
return 1
`;

/**
 * Redis/Valkey transport and atomic session storage using the host's native Bun
 * RedisClient. The adapter owns only a duplicate required by Redis pub/sub mode;
 * it never closes the supplied command client or clears application keys.
 */
export class RedisWebSocketAdapter implements WebSocketAdapter {
  readonly name = "redis";
  readonly instanceId = createInstanceId("ws-redis");
  readonly reliableRooms: RedisRoomDeliveryStore;
  private readonly operations: RedisWebSocketOperations;
  private readonly prefix: string;
  private readonly channel: string;
  private readonly writeProtectionMs: number;
  private readonly maxSessionBytes: number;
  private readonly maxPublishBytes: number;
  private readonly deliveryClient: RedisClient;
  private subscriber?: RedisClient;
  private hooks?: WebSocketAdapterHooks;

  constructor(private readonly client: RedisClient, options: RedisWebSocketAdapterOptions = {}) {
    if (options.deliveryClient !== undefined && (!options.deliveryClient || typeof options.deliveryClient.send !== "function")) throw new Error("Invalid WebSocket deliveryClient.");
    this.deliveryClient = options.deliveryClient ?? client;
    this.prefix = options.keyPrefix ?? "bazis:ws";
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(this.prefix)) throw new Error("Invalid WebSocket Redis keyPrefix.");
    this.channel = `${this.prefix}:broadcast`;
    this.writeProtectionMs = positive(options.writeProtectionMs, 60_000, "writeProtectionMs");
    this.maxSessionBytes = positive(options.maxSessionBytes, 8 * 1024 * 1024, "maxSessionBytes");
    this.maxPublishBytes = positive(options.maxPublishBytes, 1024 * 1024, "maxPublishBytes");
    this.operations = new RedisWebSocketOperations(client,
      positive(options.operationTimeoutMs, 2000, "operationTimeoutMs"),
      positive(options.maxPendingOperations, 64, "maxPendingOperations"));
    this.reliableRooms = new RedisRoomDeliveryStore({
      send: (command, args) => this.operations.run(() => this.deliveryClient.send(command, args)),
    }, this.prefix, options.reliable);
  }

  async initialize(hooks: WebSocketAdapterHooks): Promise<void> {
    if (this.subscriber) throw new Error("WebSocket Redis adapter is already initialized.");
    if (this.deliveryClient !== this.client) {
      const key = `${this.prefix}:connection-check:${this.instanceId}`;
      const nonce = crypto.randomUUID();
      await this.operations.send("SET", [key, nonce, "PX", "60000"]);
      try {
        if (await this.operations.run(() => this.deliveryClient.send("GET", [key])) !== nonce) throw new Error("WebSocket DELIVERY_STORE_MISMATCH.");
      } finally { await this.operations.send("DEL", [key]); }
    }
    await this.reliableRooms.initialize();
    let accepting = true;
    let subscriber: RedisClient;
    try {
      subscriber = await this.operations.run(async () => {
        const duplicate = await this.client.duplicate();
        if (!accepting) { duplicate.close(); throw new Error("WebSocket subscription initialization expired."); }
        return duplicate;
      }) as RedisClient;
    } finally { accepting = false; }
    this.subscriber = subscriber;
    this.hooks = hooks;
    try {
      await this.operations.run(() => subscriber.subscribe(this.channel, this.receive));
    } catch (error) {
      this.hooks = undefined;
      this.subscriber = undefined;
      subscriber.close();
      throw error;
    }
  }

  async publish(topic: string, payload: Uint8Array): Promise<void> {
    if (payload.byteLength > this.maxPublishBytes || topic.length > 1024) throw new Error("WebSocket Redis publish exceeds limits.");
    await this.operations.send("PUBLISH", [this.channel, JSON.stringify({
      source: this.instanceId, topic, payload: Buffer.from(payload).toString("base64"),
    })]);
  }

  async saveSession(state: SessionState): Promise<void> {
    await this.save(state, -1);
  }

  async compareAndSwapSession(state: SessionState, expectedRevision: number): Promise<boolean> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid WebSocket expected revision.");
    return this.save(state, expectedRevision);
  }

  async loadSession(sid: string): Promise<SessionState | null> {
    const raw = await this.operations.send("GET", [this.key(sid)]) as string | null;
    if (raw === null) return null;
    if (Buffer.byteLength(raw) > this.maxSessionBytes * 2 + 2048) throw new Error("Stored WebSocket session exceeds limits.");
    const record = JSON.parse(raw) as { deleted?: boolean; state?: string };
    // Keep application JSON opaque to Lua/cjson: empty arrays must stay arrays.
    return record.deleted || record.state === undefined ? null : JSON.parse(record.state) as SessionState;
  }

  async deleteSession(sid: string, revision?: number): Promise<void> {
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error("Invalid WebSocket deletion revision.");
    await this.operations.send("EVAL", [DELETE, "1", this.key(sid), String(revision ?? -1), String(this.writeProtectionMs), this.prefix, sid]);
  }

  async healthCheck(): Promise<void> {
    if (await this.operations.send("PING", []) !== "PONG") throw new Error("WebSocket store unavailable.");
    await this.reliableRooms.healthCheck();
  }

  async close(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    this.hooks = undefined;
    if (subscriber) {
      try { await this.operations.run(() => subscriber.unsubscribe(this.channel, this.receive)); }
      finally { subscriber.close(); }
    }
  }

  private async save(state: SessionState, expected: number): Promise<boolean> {
    if (!Number.isSafeInteger(state.revision) || state.revision! < 1
      || !Number.isFinite(state.createdAt) || !Number.isFinite(state.expiresAt)) throw new Error("Invalid WebSocket session version or timestamps.");
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > this.maxSessionBytes) throw new Error("WebSocket session exceeds Redis storage limit.");
    return Number(await this.operations.send("EVAL", [SAVE, "1", this.key(state.sid), encoded, String(expected), String(this.writeProtectionMs), this.prefix])) === 1;
  }

  private key(sid: string): string {
    if (typeof sid !== "string" || sid.length === 0 || sid.length > 128) throw new Error("Invalid WebSocket session id.");
    return `${this.prefix}:session:${encodeURIComponent(sid)}`;
  }

  private readonly receive = (message: string): void => {
    if (!this.hooks || message.length > Math.ceil(this.maxPublishBytes * 4 / 3) + 4096) return;
    try {
      const data = JSON.parse(message) as { source?: unknown; topic?: unknown; payload?: unknown; kind?: unknown; sids?: unknown };
      if (data.kind === "deliveries") {
        if (Array.isArray(data.sids) && data.sids.length <= 1000 && data.sids.every((sid) => typeof sid === "string" && sid.length <= 128)) {
          this.hooks.deliveriesReady?.(data.sids);
        }
        return;
      }
      if (typeof data.source !== "string" || data.source === this.instanceId
        || typeof data.topic !== "string" || data.topic.length > 1024 || typeof data.payload !== "string") return;
      const payload = Buffer.from(data.payload, "base64");
      if (payload.byteLength > this.maxPublishBytes) return;
      this.hooks.localPublish(data.topic, payload);
    } catch {
      // Invalid bus envelopes cannot escape a Redis callback into the process.
    }
  };
}

function positive(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`WebSocket Redis ${field} must be a positive integer.`);
  return value;
}
