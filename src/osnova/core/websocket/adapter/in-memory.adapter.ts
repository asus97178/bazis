import { SessionCapacityError, type SessionState } from "../session-manager";
import { localSessionCreationOrder } from "../session-creation";
import {
  createInstanceId,
  type WebSocketAdapter,
  type WebSocketAdapterHooks,
} from "./adapter.interface";

export interface InMemoryWebSocketAdapterOptions {
  /** Bound for live sessions. Default 10,000. Deletion history has its own cap. */
  readonly maxEntries?: number;
  /** Maximum deletion markers before conservative compaction. Default maxEntries. */
  readonly maxTombstones?: number;
  /** Initial-write/deletion protection window. Default 60 seconds. */
  readonly tombstoneTtlMs?: number;
}

export class InMemoryWebSocketAdapter implements WebSocketAdapter {
  readonly name = "in-memory";
  readonly instanceId = createInstanceId();

  private hooks: WebSocketAdapterHooks | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly tombstones = new Map<string, { revision: number; expiresAt: number; createdAt: number; creationToken?: string }>();
  private readonly maxEntries: number;
  private readonly maxTombstones: number;
  private readonly tombstoneTtlMs: number;
  private creationFloor = 0;
  private legacyCreationFloor = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(options: InMemoryWebSocketAdapterOptions = {}) {
    this.maxEntries = positiveInteger(options.maxEntries, 10_000, "maxEntries");
    this.maxTombstones = positiveInteger(options.maxTombstones, this.maxEntries, "maxTombstones");
    this.tombstoneTtlMs = positiveInteger(options.tombstoneTtlMs, 60_000, "tombstoneTtlMs");
  }

  async initialize(hooks: WebSocketAdapterHooks): Promise<void> {
    this.closed = false;
    this.hooks = hooks;
  }

  /**
   * Single-node: room fan-out is already delivered locally by the originating
   * socket's `ws.publish`, so cross-node publish is a no-op. (`localPublish`
   * exists for real multi-node adapters that receive off a bus.)
   */
  async publish(_topic: string, _payload: Uint8Array): Promise<void> {
    void this.hooks;
  }

  async saveSession(state: SessionState): Promise<void> {
    if (this.closed) return;
    this.purgeTombstones();
    const current = this.sessions.get(state.sid);
    const revision = state.revision ?? 0;
    if (
      (!current && !this.canCreate(state))
      || (current && (current.createdAt !== state.createdAt || current.creationToken !== state.creationToken))
      || (current?.revision ?? 0) >= revision
      || (this.tombstones.get(state.sid)?.revision ?? -1) >= revision
    ) {
      return;
    }
    this.ensureCapacity(state.sid);
    this.sessions.set(state.sid, structuredClone(state));
    this.tombstones.delete(state.sid);
  }

  async compareAndSwapSession(state: SessionState, expectedRevision: number): Promise<boolean> {
    if (this.closed) return false;
    this.purgeTombstones();
    const current = this.sessions.get(state.sid);
    const currentRevision = current?.revision ?? this.tombstones.get(state.sid)?.revision ?? 0;
    if (
      currentRevision !== expectedRevision
      || (state.revision ?? 0) <= expectedRevision
      || (!current && !this.canCreate(state))
      || (current && (current.createdAt !== state.createdAt || current.creationToken !== state.creationToken))
    ) {
      return false;
    }
    this.ensureCapacity(state.sid);
    this.sessions.set(state.sid, structuredClone(state));
    this.tombstones.delete(state.sid);
    return true;
  }

  async loadSession(sid: string): Promise<SessionState | null> {
    this.purgeTombstones();
    const state = this.sessions.get(sid);
    return state ? structuredClone(state) : null;
  }

  async deleteSession(sid: string, revision?: number): Promise<void> {
    if (this.closed) return;
    this.purgeTombstones();
    const current = this.sessions.get(sid);
    const currentRevision = current?.revision ?? 0;
    if (revision !== undefined && revision < currentRevision) {
      return;
    }
    const previous = this.tombstones.get(sid);
    const tombstoneRevision = Math.max(
      previous?.revision ?? 0,
      revision ?? currentRevision + 1,
    );
    // Once a session's creation window is over, an absent SID cannot be
    // restored by its old snapshots. No per-SID marker is needed beyond it.
    const expiresAt = current
      ? current.createdAt + this.tombstoneTtlMs
      : previous?.expiresAt ?? Date.now() + this.tombstoneTtlMs;
    const marker = { revision: tombstoneRevision, expiresAt,
      createdAt: current?.createdAt ?? previous?.createdAt ?? Date.now(),
      creationToken: current?.creationToken ?? previous?.creationToken };
    if (expiresAt <= Date.now()) {
      this.sessions.delete(sid);
      this.tombstones.delete(sid);
      this.compact(marker);
      return;
    }
    this.sessions.delete(sid);
    this.tombstones.set(sid, marker);
    while (this.tombstones.size > this.maxTombstones) {
      const [oldestSid, oldest] = this.tombstones.entries().next().value!;
      this.compact(oldest);
      this.tombstones.delete(oldestSid);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.hooks = null;
    for (const state of this.sessions.values()) this.compact(state);
    for (const marker of this.tombstones.values()) this.compact(marker);
    this.sessions.clear();
    this.tombstones.clear();
  }

  /** DevTools: count of sessions stored in adapter. */
  sessionCount(): number {
    return this.sessions.size;
  }

  private canCreate(state: SessionState): boolean {
    // A deleted SID is never reused, including by a snapshot with a larger
    // revision. Once the marker is compacted, the creation floor takes over.
    if (this.tombstones.has(state.sid)) return false;
    const order = localSessionCreationOrder(state.creationToken);
    if (order !== undefined) return order > this.creationFloor;
    return Number.isFinite(state.createdAt)
      && state.createdAt > this.legacyCreationFloor
      && state.createdAt > Date.now() - this.tombstoneTtlMs;
  }

  private compact(state: { createdAt: number; creationToken?: string }): void {
    const order = localSessionCreationOrder(state.creationToken);
    if (order !== undefined) this.creationFloor = Math.max(this.creationFloor, order);
    this.legacyCreationFloor = Math.max(this.legacyCreationFloor, state.createdAt);
  }

  private purgeTombstones(): void {
    const now = Date.now();
    for (const [sid, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) {
        this.compact(tombstone);
        this.tombstones.delete(sid);
      }
    }
  }

  private ensureCapacity(sid: string): void {
    if (
      !this.sessions.has(sid)
      && this.sessions.size >= this.maxEntries
    ) {
      throw new SessionCapacityError(this.maxEntries);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`WebSocket in-memory ${field} must be a positive integer.`);
  }
  return value;
}

export const inMemoryWebSocketAdapter = new InMemoryWebSocketAdapter();
