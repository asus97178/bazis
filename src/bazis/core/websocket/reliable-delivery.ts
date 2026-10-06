import type { ServerPacket } from "./types";

export interface ReliableBroadcastOptions {
  /** UUID v4, reused unchanged when retrying an indeterminate publication. */
  readonly messageId: string;
  /** Acceptance deadline (Unix ms), reused on retry; at most 60s ahead. */
  readonly expiresAt: number;
}

export interface ReliableBroadcastReceipt {
  readonly messageId: string;
  readonly recipients: number;
  readonly duplicate: boolean;
}

export interface ReliableRoomPublication extends ReliableBroadcastOptions {
  readonly namespace: string;
  readonly room: string;
  readonly excludeSid: string;
  readonly packet: ServerPacket;
}

export interface ReliableSessionOwner {
  readonly sid: string;
  readonly connId: string;
  readonly ownerInstanceId: string;
  /** Read-only cursor: skip already issued, unacknowledged frames on this connection. */
  readonly issuedIds?: readonly string[];
}

export interface ReliableDeliveryBatch {
  readonly sid: string;
  readonly packets: readonly ServerPacket[];
}

/** Optional adapter capability; queue updates do not change session revisions. */
export interface ReliableRoomDelivery {
  publish(request: ReliableRoomPublication): Promise<ReliableBroadcastReceipt>;
  readPending(owners: readonly ReliableSessionOwner[]): Promise<readonly ReliableDeliveryBatch[]>;
  acknowledge(owner: ReliableSessionOwner, deliveryIds: readonly string[]): Promise<number>;
}

export class WebSocketDeliveryError extends Error {
  constructor(readonly code: string, message = `WebSocket delivery rejected: ${code}.`) {
    super(message);
    this.name = "WebSocketDeliveryError";
  }
}

export interface WebSocketDiagnostic {
  readonly type: "queue-rejected" | "adapter-error" | "lease-lost" | "reliable-published" | "reliable-rejected" | "reliable-acked" | "poll-error";
  readonly timestamp: number;
  readonly count: number;
}

export const deliveryUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
