import type { SessionState } from "../session-manager";
import type { ReliableRoomDelivery } from "../reliable-delivery";

export interface WebSocketAdapterHooks {
  /** Deliver payload to all local subscribers of topic (Bun server.publish). */
  localPublish: (topic: string, payload: Uint8Array) => void;
  /** Advisory wake-up only; persisted mailboxes are also polled. */
  deliveriesReady?: (sids: readonly string[]) => void;
}

export interface WebSocketAdapter {
  readonly name: string;
  readonly instanceId: string;
  readonly reliableRooms?: ReliableRoomDelivery;
  /** Readiness of the backing store; rejection means unavailable. */
  healthCheck?(): Promise<void>;

  initialize(hooks: WebSocketAdapterHooks): Promise<void>;

  /** Fan-out to all nodes; each node calls localPublish for local subscribers. */
  publish(topic: string, payload: Uint8Array): Promise<void>;

  /** Persist only when `state.revision` is newer than the stored revision. */
  saveSession(state: SessionState): Promise<void>;
  /**
   * Optional optimistic claim used by distributed adapters when a physical
   * connection takes ownership of a session. Implementations must only store
   * `state` when the currently persisted revision equals `expectedRevision`.
   * Returning `false` keeps the existing owner. Older adapters remain valid;
   * the runtime falls back to ordered `saveSession` calls on one node.
   */
  compareAndSwapSession?(state: SessionState, expectedRevision: number): Promise<boolean>;
  loadSession(sid: string): Promise<SessionState | null>;
  /**
   * Deletes a session. Version-aware distributed adapters should retain a
   * tombstone at `revision` so a delayed older save cannot resurrect it.
   */
  deleteSession(sid: string, revision?: number): Promise<void>;

  close(): Promise<void>;
}

export function createInstanceId(prefix = "osnova"): string {
  return `${prefix}-${process.pid}-${crypto.randomUUID()}`;
}
