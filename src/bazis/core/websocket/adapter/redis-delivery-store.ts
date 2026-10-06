import { canonicalJsonHashV1 } from "../../../library/boundary";
import type { ServerPacket } from "../types";
import { deliveryUuid, WebSocketDeliveryError, type ReliableRoomDelivery, type ReliableRoomPublication, type ReliableSessionOwner, type ReliableDeliveryBatch, type ReliableBroadcastReceipt } from "../reliable-delivery";
import { RedisWebSocketOperations } from "./redis-operations";
import { PUBLISH, READ, ACK } from "./redis-delivery-scripts";

export interface RedisReliableDeliveryOptions {
  readonly requireAof?: boolean;
  readonly maxQueueMessages?: number;
  readonly maxQueueBytes?: number;
  readonly maxRecipients?: number;
  readonly maxFanoutBytes?: number;
  readonly maxOperations?: number;
  readonly maxReadBytes?: number;
}

export class RedisRoomDeliveryStore implements ReliableRoomDelivery {
  private readonly limits: Required<Omit<RedisReliableDeliveryOptions, "requireAof">>;
  private readonly requireAof: boolean;
  constructor(private readonly operations: Pick<RedisWebSocketOperations, "send">, private readonly prefix: string, options: RedisReliableDeliveryOptions = {}) {
    if (options.requireAof !== undefined && typeof options.requireAof !== "boolean") throw new Error("Invalid Redis reliable requireAof.");
    this.requireAof = options.requireAof ?? true;
    this.limits = { maxQueueMessages: 100, maxQueueBytes: 1024 * 1024, maxRecipients: 1000,
      maxFanoutBytes: 8 * 1024 * 1024, maxOperations: 10_000, maxReadBytes: 1024 * 1024 };
    for (const key of Object.keys(this.limits) as (keyof typeof this.limits)[]) {
      const value = options[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Redis reliable ${key}.`);
        this.limits = { ...this.limits, [key]: value };
      }
    }
    if (this.limits.maxReadBytes < this.limits.maxQueueBytes) throw new Error("Redis reliable maxReadBytes must cover maxQueueBytes.");
  }

  async initialize(): Promise<void> {
    await this.healthCheck();
    const policy = JSON.stringify({ ...this.limits, requireAof: this.requireAof });
    const key = `${this.prefix}:delivery-policy`;
    await this.operations.send("SET", [key, policy, "NX"]);
    if (await this.operations.send("GET", [key]) !== policy) throw new WebSocketDeliveryError("DELIVERY_POLICY_MISMATCH");
  }

  async healthCheck(): Promise<void> {
    if (!this.requireAof) return;
    const settings = await this.operations.send("CONFIG", ["GET", "appendonly", "appendfsync", "no-appendfsync-on-rewrite", "maxmemory-policy"]) as string[] | Record<string, string>;
    const values = new Map<string, string>();
    if (Array.isArray(settings)) for (let i = 0; i < settings.length; i += 2) values.set(settings[i]!, settings[i + 1]!);
    else for (const [key, value] of Object.entries(settings)) values.set(key, value);
    const info = await this.operations.send("INFO", ["persistence"]) as string;
    if (values.get("appendonly") !== "yes" || values.get("appendfsync") !== "always" || values.get("maxmemory-policy") !== "noeviction"
      || values.get("no-appendfsync-on-rewrite") !== "no"
      || !info.includes("aof_last_write_status:ok") || !info.includes("loading:0")) throw new WebSocketDeliveryError("DURABILITY_CONFIGURATION");
  }

  async publish(request: ReliableRoomPublication): Promise<ReliableBroadcastReceipt> {
    if (!deliveryUuid.test(request.messageId) || !Number.isSafeInteger(request.expiresAt)
      || typeof request.namespace !== "string" || request.namespace.length > 256 || request.namespace.includes("\0")
      || typeof request.room !== "string" || !request.room.length || request.room.length > 256 || request.room.includes("\0")
      || typeof request.excludeSid !== "string" || request.excludeSid.length > 128
      || request.packet.type !== "event" || typeof request.packet.event !== "string" || !request.packet.event.length
      || request.packet.event.length > 256) throw new WebSocketDeliveryError("INVALID_PUBLICATION");
    const packet = JSON.stringify({ ...request.packet, v: 1, namespace: request.namespace, deliveryId: request.messageId });
    if (Buffer.byteLength(packet) > this.limits.maxQueueBytes) throw new WebSocketDeliveryError("QUEUE_CAPACITY");
    const metadata = JSON.stringify({ messageId: request.messageId, expiresAt: request.expiresAt,
      namespace: request.namespace, room: request.room, excludeSid: request.excludeSid });
    const fingerprint = canonicalJsonHashV1("bazis.websocket.publication/v1", { metadata: JSON.parse(metadata), packet: JSON.parse(packet) });
    const result = await this.operations.send("EVAL", [PUBLISH, "0", this.prefix, metadata, JSON.stringify(this.limits), fingerprint, packet]) as string[];
    if (result[0] !== "OK") throw new WebSocketDeliveryError(result[0] ?? "STORE_PROTOCOL");
    return { messageId: request.messageId, recipients: Number(result[1]), duplicate: result[2] === "1" };
  }

  async readPending(owners: readonly ReliableSessionOwner[]): Promise<readonly ReliableDeliveryBatch[]> {
    if (owners.length > 128 || owners.some((owner) => (owner.issuedIds?.length ?? 0) > this.limits.maxQueueMessages)) throw new WebSocketDeliveryError("READ_CAPACITY");
    if (!owners.length) return [];
    const rows = await this.operations.send("EVAL", [READ, "0", this.prefix, JSON.stringify(owners), String(this.limits.maxReadBytes), String(this.limits.maxQueueMessages)]) as string[][];
    return rows.map(([sid, ...packets]) => ({ sid: sid!, packets: packets.map((packet) => JSON.parse(packet) as ServerPacket) }));
  }

  async acknowledge(owner: ReliableSessionOwner, deliveryIds: readonly string[]): Promise<number> {
    if (!deliveryIds.length) return 0;
    if (deliveryIds.length > this.limits.maxQueueMessages || deliveryIds.some((id) => !deliveryUuid.test(id))) throw new WebSocketDeliveryError("INVALID_ACK");
    const count = Number(await this.operations.send("EVAL", [ACK, "0", this.prefix, JSON.stringify(owner), JSON.stringify(deliveryIds), String(this.limits.maxQueueMessages)]));
    if (count < 0) throw new WebSocketDeliveryError("OWNERSHIP_LOST");
    return count;
  }
}
