import type { ReplayDelivery, ServerPacket, SocketContext } from "./types";
import type { WebSocketAdapter } from "./adapter/adapter.interface";
import { issueSessionCreationToken } from "./session-creation";

const ROOM_SEPARATOR = "\0";
const encoder = new TextEncoder();

export interface SessionState {
  sid: string;
  namespace: string;
  context: SocketContext;
  rooms: string[];
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  outboundQueue: ServerPacket[];
  activeConnId?: string;
  /** Monotonic state version. Optional for compatibility with older adapters. */
  revision?: number;
  /** Namespace-specific reconnect TTL. */
  ttlMs?: number;
  /** Approximate serialized bytes currently retained in `outboundQueue`. */
  outboundQueueBytes?: number;
  /** A live connection must renew this lease; stale active markers expire. */
  activeLeaseExpiresAt?: number;
  /** Adapter/node instance that currently owns `activeConnId`. */
  ownerInstanceId?: string;
  /** Immutable process-local creation order for bounded in-memory deletion history. */
  creationToken?: string;
  /** Client-ack replay cannot be downgraded by a later connection. */
  replayDelivery?: ReplayDelivery;
}

export interface SessionManagerOptions {
  defaultTtlMs?: number;
  maxOutboundQueue?: number;
  maxOutboundQueueBytes?: number;
  maxSessions?: number;
  maxRoomsPerSession?: number;
  maxRoomNameLength?: number;
  maxOfflineBroadcastRecipients?: number;
  maxOfflineBroadcastBytes?: number;
  activeLeaseMs?: number;
  adapter?: WebSocketAdapter | null;
}

export interface OfflineBroadcastResult {
  readonly queued: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

export class SessionCapacityError extends Error {
  public constructor(maxSessions: number) {
    super(`WebSocket session capacity exceeded (${maxSessions}).`);
    this.name = "SessionCapacityError";
  }
}

/**
 * Local session index with ordered persistence. All mutations receive a
 * monotonic revision and adapter writes for one SID are serialized. Critical
 * server boundaries call `flushSession` before acknowledging reconnect/state.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly roomMembers = new Map<string, Set<string>>();
  private readonly persistenceTails = new Map<string, Promise<void>>();
  private readonly persistenceErrors = new Map<string, unknown>();
  private readonly defaultTtlMs: number;
  private readonly maxOutboundQueue: number;
  private readonly maxOutboundQueueBytes: number;
  private readonly maxSessions: number;
  private readonly maxRoomsPerSession: number;
  private readonly maxRoomNameLength: number;
  private readonly maxOfflineBroadcastRecipients: number;
  private readonly maxOfflineBroadcastBytes: number;
  private readonly activeLeaseMs: number;
  private readonly adapter: WebSocketAdapter | null;

  constructor(options: SessionManagerOptions = {}) {
    this.defaultTtlMs = positiveInteger(options.defaultTtlMs, 2 * 60 * 60 * 1000);
    this.maxOutboundQueue = positiveInteger(options.maxOutboundQueue, 100);
    this.maxOutboundQueueBytes = positiveInteger(options.maxOutboundQueueBytes, 1024 * 1024);
    this.maxSessions = positiveInteger(options.maxSessions, 10_000);
    this.maxRoomsPerSession = positiveInteger(options.maxRoomsPerSession, 256);
    this.maxRoomNameLength = positiveInteger(options.maxRoomNameLength, 256);
    this.maxOfflineBroadcastRecipients = positiveInteger(options.maxOfflineBroadcastRecipients, 1_000);
    this.maxOfflineBroadcastBytes = positiveInteger(options.maxOfflineBroadcastBytes, 1024 * 1024);
    this.activeLeaseMs = positiveInteger(options.activeLeaseMs, 30_000);
    this.adapter = options.adapter ?? null;
  }

  createSession(
    sid: string,
    namespace: string,
    context: SocketContext,
    ttlMs?: number,
    replayDelivery: ReplayDelivery = "transport",
  ): SessionState {
    this.purgeExpired();
    this.ensureSessionCapacity(sid);
    const now = Date.now();
    const resolvedTtl = positiveInteger(ttlMs, this.defaultTtlMs);
    const state: SessionState = {
      sid,
      namespace,
      context: cloneSocketContext(context),
      rooms: [],
      createdAt: now,
      creationToken: issueSessionCreationToken(),
      lastSeenAt: now,
      expiresAt: now + resolvedTtl,
      outboundQueue: [],
      revision: 1,
      ttlMs: resolvedTtl,
      outboundQueueBytes: 0,
      ...(replayDelivery === "client-ack" ? { replayDelivery } : {}),
    };
    const previous = this.sessions.get(sid);
    if (previous) {
      this.removeRoomIndex(previous);
    }
    this.sessions.set(sid, state);
    this.addRoomIndex(state);
    this.enqueueSave(state);
    return state;
  }

  hasCapacity(): boolean {
    this.purgeExpired();
    return this.sessions.size < this.maxSessions;
  }

  getSession(sid: string): SessionState | undefined {
    this.purgeExpired();
    const state = this.sessions.get(sid);
    if (!state) {
      return undefined;
    }
    this.expireStaleLease(state);
    if (Date.now() > state.expiresAt && !this.isActive(state)) {
      this.removeLocalSession(state);
      this.enqueueDelete(sid, (state.revision ?? 0) + 1);
      return undefined;
    }
    return state;
  }

  async resolveSession(sid: string, signal?: AbortSignal): Promise<SessionState | undefined> {
    signal?.throwIfAborted();
    await this.flushSession(sid);
    signal?.throwIfAborted();
    let local = this.sessions.get(sid);
    if (local) {
      local = await this.refreshLocalFromAdapter(local, signal);
      signal?.throwIfAborted();
      this.expireStaleLease(local);
      if (Date.now() > local.expiresAt && !this.isActive(local)) {
        this.removeLocalSession(local);
        this.enqueueDelete(sid, (local.revision ?? 0) + 1);
        return undefined;
      }
      return local;
    }
    if (!this.adapter) {
      return undefined;
    }
    const loaded = await this.adapter.loadSession(sid);
    signal?.throwIfAborted();
    if (!loaded) {
      return undefined;
    }
    const remote = this.normalizeLoadedState(loaded);
    this.expireStaleLease(remote);
    if (Date.now() > remote.expiresAt && !this.isActive(remote)) {
      await this.adapter.deleteSession(sid, (remote.revision ?? 0) + 1);
      return undefined;
    }
    this.ensureSessionCapacity(sid);
    this.sessions.set(sid, remote);
    this.addRoomIndex(remote);
    return remote;
  }

  touchSession(sid: string, connId?: string): boolean {
    const state = this.sessions.get(sid);
    if (!state) {
      return false;
    }
    const now = Date.now();
    if (connId !== undefined && (state.activeConnId !== connId || !this.isActive(state, now))) {
      // Once the local lease has elapsed, another node may already have claimed
      // the SID. Never extend it; discard this socket's stale local owner state.
      if (state.activeConnId === connId) {
        this.removeLocalSession(state);
      }
      return false;
    }
    if (connId === undefined) {
      this.purgeExpired();
      if (this.sessions.get(sid) !== state) {
        return false;
      }
    }
    if (connId !== undefined) {
      // Traffic is not a reason to fsync the entire session on every frame.
      // Keep the persisted expiry/lease unchanged until renewal is due, so a
      // local touch can never claim a longer lease than the store has accepted.
      const ttl = this.ttlOf(state);
      const refreshedAt = Math.min(state.expiresAt - ttl, state.activeLeaseExpiresAt! - this.activeLeaseMs);
      if (now - refreshedAt < Math.max(1, Math.floor(Math.min(ttl, this.activeLeaseMs) / 3))) {
        state.lastSeenAt = now;
        return true;
      }
    }
    state.lastSeenAt = now;
    state.expiresAt = now + this.ttlOf(state);
    if (state.activeConnId) {
      state.activeLeaseExpiresAt = now + this.activeLeaseMs;
    }
    this.bumpAndSave(state);
    return true;
  }

  /**
   * Claims one active physical connection for a SID. A live lease owned by a
   * different adapter instance is rejected; same-node replacement is allowed
   * so the server can close the previous socket deterministically.
   */
  async claimActiveConnection(sid: string, connId: string): Promise<boolean> {
    await this.flushSession(sid);
    let state = this.sessions.get(sid);
    if (!state) {
      return false;
    }
    state = await this.refreshLocalFromAdapter(state);
    const now = Date.now();
    this.expireStaleLease(state, now);
    if (now > state.expiresAt && !this.isActive(state, now)) {
      this.removeLocalSession(state);
      this.enqueueDelete(sid, (state.revision ?? 0) + 1);
      return false;
    }
    if (
      this.isActive(state, now)
      && state.activeConnId !== connId
      && state.ownerInstanceId !== this.adapter?.instanceId
    ) {
      return false;
    }

    const expectedRevision = state.revision ?? 0;
    const previous = {
      activeConnId: state.activeConnId,
      ownerInstanceId: state.ownerInstanceId,
      activeLeaseExpiresAt: state.activeLeaseExpiresAt,
      lastSeenAt: state.lastSeenAt,
      expiresAt: state.expiresAt,
      revision: state.revision,
    };
    state.activeConnId = connId;
    state.ownerInstanceId = this.adapter?.instanceId ?? "local";
    state.activeLeaseExpiresAt = now + this.activeLeaseMs;
    state.lastSeenAt = now;
    state.expiresAt = now + this.ttlOf(state);
    state.revision = expectedRevision + 1;

    try {
      const claimed = await this.enqueueSave(state, expectedRevision);
      if (claimed) {
        return true;
      }
    } catch (error) {
      Object.assign(state, previous);
      throw error;
    }

    Object.assign(state, previous);
    return false;
  }

  /** @deprecated Prefer awaited `claimActiveConnection` at runtime boundaries. */
  setActiveConnection(sid: string, connId: string): void {
    void this.claimActiveConnection(sid, connId).catch(() => {});
  }

  /** @deprecated Runtime boundaries should await `releaseActiveConnection`. */
  clearActiveConnection(sid: string, expectedConnId?: string): void {
    this.purgeExpired();
    const state = this.sessions.get(sid);
    if (!state || (expectedConnId !== undefined && state.activeConnId !== expectedConnId)) {
      return;
    }
    const now = Date.now();
    state.activeConnId = undefined;
    state.ownerInstanceId = undefined;
    state.activeLeaseExpiresAt = undefined;
    state.lastSeenAt = now;
    state.expiresAt = now + this.ttlOf(state);
    this.bumpAndSave(state);
  }

  /** Atomically snapshots rooms and releases the active connection lease. */
  async releaseActiveConnection(
    sid: string,
    expectedConnId: string,
    rooms?: Iterable<string>,
  ): Promise<boolean> {
    await this.flushSession(sid);
    let state = this.sessions.get(sid);
    if (!state) {
      return false;
    }
    state = await this.refreshLocalFromAdapter(state);
    if (state.activeConnId !== expectedConnId) {
      return false;
    }

    const expectedRevision = state.revision ?? 0;
    if (rooms !== undefined) {
      const previousRooms = state.rooms;
      state.rooms = this.normalizeRooms(rooms);
      this.replaceRoomIndex(state, previousRooms);
    }
    const now = Date.now();
    state.activeConnId = undefined;
    state.ownerInstanceId = undefined;
    state.activeLeaseExpiresAt = undefined;
    state.lastSeenAt = now;
    state.expiresAt = now + this.ttlOf(state);
    state.revision = expectedRevision + 1;

    try {
      const released = await this.enqueueSave(state, expectedRevision);
      if (!released && this.sessions.get(sid) === state) {
        this.removeLocalSession(state);
      }
      return released;
    } catch (error) {
      if (this.sessions.get(sid) === state) {
        this.removeLocalSession(state);
      }
      throw error;
    }
  }

  updateRooms(sid: string, rooms: Iterable<string>): void {
    this.purgeExpired();
    const state = this.sessions.get(sid);
    if (!state) {
      return;
    }
    const previousRooms = state.rooms;
    state.rooms = this.normalizeRooms(rooms);
    state.lastSeenAt = Date.now();
    this.replaceRoomIndex(state, previousRooms);
    this.bumpAndSave(state);
  }

  updateContext(sid: string, context: SocketContext): void {
    this.purgeExpired();
    const state = this.sessions.get(sid);
    if (!state) {
      return;
    }
    state.context = cloneSocketContext(context);
    state.lastSeenAt = Date.now();
    this.bumpAndSave(state);
  }

  enqueueOutbound(sid: string, packet: ServerPacket, _packetBytes?: number): boolean {
    this.purgeExpired();
    const state = this.sessions.get(sid);
    if (!state) {
      return false;
    }
    return this.enqueueOutboundState(state, packet);
  }

  /** Queues a broadcast by indexed room membership, never by scanning all sessions. */
  enqueueToOfflineRoomMembers(
    namespace: string,
    room: string,
    packet: ServerPacket,
    excludeSid?: string,
    _packetBytes?: number,
    allOrNothing = false,
  ): OfflineBroadcastResult {
    this.purgeExpired();
    // Queue memory/persistence is the serialized packet object, independent of
    // the live wire codec used for the immediate broadcast.
    const packetBytes = serializedBytes(packet);
    const members = this.roomMembers.get(roomKey(namespace, room));
    if (!members || packetBytes > this.maxOfflineBroadcastBytes) {
      return { queued: 0, bytes: 0, truncated: packetBytes > this.maxOfflineBroadcastBytes };
    }

    let queued = 0;
    let bytes = 0;
    let truncated = false;
    if (allOrNothing) {
      const targets: SessionState[] = [];
      let total = 0;
      for (const sid of members) {
        const state = this.sessions.get(sid);
        if (!state || this.isActive(state) || state.namespace !== namespace || sid === excludeSid) continue;
        const added = serializedBytes(state.replayDelivery === "client-ack"
          ? { ...packet, deliveryId: "00000000-0000-4000-8000-000000000000" } : packet);
        if (targets.length >= this.maxOfflineBroadcastRecipients || total + added > this.maxOfflineBroadcastBytes
          || state.outboundQueue.length >= this.maxOutboundQueue || (state.outboundQueueBytes ?? 0) + added > this.maxOutboundQueueBytes) {
          return { queued: 0, bytes: 0, truncated: true };
        }
        targets.push(state); total += added;
      }
      for (const state of targets) this.enqueueOutboundState(state, packet);
      return { queued: targets.length, bytes: total, truncated: false };
    }
    for (const sid of members) {
      const state = this.sessions.get(sid);
      if (!state || this.isActive(state) || state.namespace !== namespace || sid === excludeSid) continue;
      if (queued >= this.maxOfflineBroadcastRecipients || bytes + packetBytes > this.maxOfflineBroadcastBytes) {
        truncated = true;
        break;
      }
      if (this.enqueueOutboundState(state, packet)) {
        queued += 1;
        bytes += packetBytes;
      } else {
        truncated = true;
      }
    }
    return { queued, bytes, truncated };
  }

  /** Snapshot for transport encoding; reading never consumes replay. */
  peekOutbound(sid: string): readonly ServerPacket[] {
    return this.getSession(sid)?.outboundQueue.slice() ?? [];
  }

  /** Upgrade an owned legacy queue before issuing stable replay identities. */
  enableReplayAcknowledgements(sid: string): void {
    const state = this.sessions.get(sid);
    if (!state || state.replayDelivery === "client-ack") return;
    const queue = state.outboundQueue.map((packet) => ({ ...packet, deliveryId: crypto.randomUUID() }));
    const bytes = queue.reduce((total, packet) => total + serializedBytes(packet), 0);
    if (bytes > this.maxOutboundQueueBytes) throw new Error("WebSocket replay identities exceed the queue byte limit.");
    state.replayDelivery = "client-ack";
    state.outboundQueue = queue;
    state.outboundQueueBytes = bytes;
    this.bumpAndSave(state);
  }

  /** The server must first validate IDs against replay issued to this connection. */
  acknowledgeDeliveries(sid: string, deliveryIds: readonly string[]): number {
    const state = this.sessions.get(sid);
    if (!state || state.replayDelivery !== "client-ack") return 0;
    const ids = new Set(deliveryIds);
    const remaining = state.outboundQueue.filter((packet) => !packet.deliveryId || !ids.has(packet.deliveryId));
    const removed = state.outboundQueue.length - remaining.length;
    if (removed > 0) {
      state.outboundQueue = remaining;
      state.outboundQueueBytes = remaining.reduce((bytes, packet) => bytes + serializedBytes(packet), 0);
      this.bumpAndSave(state);
    }
    return removed;
  }

  /** Remove only a prefix that the transport has accepted, without an intervening await. */
  acknowledgeOutbound(sid: string, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("WebSocket replay acknowledgement count must be a non-negative integer.");
    }
    const state = this.sessions.get(sid);
    if (state?.replayDelivery === "client-ack" && count > 0) {
      throw new Error("Client-ack replay requires delivery identities, not a transport prefix.");
    }
    if (!state || count === 0) {
      return;
    }
    if (count > state.outboundQueue.length) {
      throw new Error("WebSocket replay acknowledgement exceeds the queued prefix.");
    }
    const removed = state.outboundQueue.splice(0, count);
    state.outboundQueueBytes = Math.max(0,
      (state.outboundQueueBytes ?? 0) - removed.reduce((bytes, packet) => bytes + serializedBytes(packet), 0));
    this.bumpAndSave(state);
  }

  drainOutbound(sid: string, maxBytes = Number.POSITIVE_INFINITY): ServerPacket[] {
    this.purgeExpired();
    const state = this.sessions.get(sid);
    if (!state) {
      return [];
    }
    const missed: ServerPacket[] = [];
    let drainedBytes = 0;
    for (const next of state.outboundQueue) {
      const bytes = serializedBytes(next);
      if (drainedBytes + bytes > maxBytes) {
        break;
      }
      missed.push(next);
      drainedBytes += bytes;
    }
    this.acknowledgeOutbound(sid, missed.length);
    return missed;
  }

  deleteSession(sid: string): void {
    const state = this.sessions.get(sid);
    if (state) {
      this.removeLocalSession(state);
    }
    this.enqueueDelete(sid, state === undefined ? undefined : (state.revision ?? 0) + 1);
  }

  getStats(): { sessions: number; queuedMessages: number } {
    this.purgeExpired();
    let queuedMessages = 0;
    for (const state of this.sessions.values()) {
      queuedMessages += state.outboundQueue.length;
    }
    return { sessions: this.sessions.size, queuedMessages };
  }

  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const state of this.sessions.values()) {
      this.expireStaleLease(state, now);
      if (now > state.expiresAt && !this.isActive(state, now)) {
        this.removeLocalSession(state);
        this.enqueueDelete(state.sid, (state.revision ?? 0) + 1);
        purged += 1;
      }
    }
    return purged;
  }

  /**
   * Renews leases owned by this adapter/node; called by the server heartbeat.
   * Returns SIDs whose optimistic renewal lost to a newer distributed owner.
   */
  async renewOwnedLeases(schedule?: { afterMs: number; spreadMs: number }): Promise<string[]> {
    if (schedule && (!Number.isSafeInteger(schedule.afterMs) || schedule.afterMs < 0
      || !Number.isSafeInteger(schedule.spreadMs) || schedule.spreadMs < 0)) throw new Error("Invalid lease renewal schedule.");
    const owner = this.adapter?.instanceId ?? "local";
    const states = [...this.sessions.values()];
    const lostOwnership: string[] = [];
    let cursor = 0;
    // Bounded native I/O, while each SID still enters its ordered persistence
    // chain immediately after mutation. Delaying only the save would reorder it
    // behind concurrent message updates.
    const worker = async (): Promise<void> => {
      while (cursor < states.length) {
        const state = states[cursor++]!;
        if (this.sessions.get(state.sid) !== state || !state.activeConnId || state.ownerInstanceId !== owner) continue;
        const now = Date.now();
        if (!this.isActive(state, now)) {
          this.removeLocalSession(state);
          lostOwnership.push(state.sid);
          continue;
        }
        if (schedule) {
          const lifetime = Math.min(this.activeLeaseMs, this.ttlOf(state));
          const after = Math.min(schedule.afterMs, Math.floor(lifetime / 3));
          const spread = Math.min(schedule.spreadMs, Math.floor((lifetime - after) / 2));
          let hash = 2166136261;
          for (let i = 0; i < state.sid.length; i++) hash = Math.imul(hash ^ state.sid.charCodeAt(i), 16777619) >>> 0;
          const refreshedAt = Math.min(state.activeLeaseExpiresAt! - this.activeLeaseMs, state.expiresAt - this.ttlOf(state));
          if (now < refreshedAt + after + hash % (spread + 1)) continue;
        }
        const expectedRevision = state.revision ?? 0;
        state.activeLeaseExpiresAt = now + this.activeLeaseMs;
        state.lastSeenAt = now;
        state.expiresAt = now + this.ttlOf(state);
        state.revision = expectedRevision + 1;
        try {
          if (!await this.enqueueSave(state, expectedRevision) && this.sessions.get(state.sid) === state) {
            this.removeLocalSession(state);
            lostOwnership.push(state.sid);
          }
        } catch (error) {
          if (this.sessions.get(state.sid) === state) this.removeLocalSession(state);
          throw error;
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(16, states.length) }, worker));
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return lostOwnership;
  }

  async flushSession(sid: string): Promise<void> {
    const tail = this.persistenceTails.get(sid);
    if (tail) {
      await tail.catch(() => {});
    }
    if (this.persistenceErrors.has(sid)) {
      const error = this.persistenceErrors.get(sid);
      this.persistenceErrors.delete(sid);
      throw error;
    }
  }

  async flushAll(): Promise<void> {
    const sids = new Set([...this.persistenceTails.keys(), ...this.persistenceErrors.keys()]);
    const errors: unknown[] = [];
    for (const sid of sids) {
      try {
        await this.flushSession(sid);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private normalizeLoadedState(state: SessionState): SessionState {
    const ttlMs = positiveInteger(state.ttlMs, this.defaultTtlMs);
    if (state.replayDelivery === "client-ack" && (
      !Array.isArray(state.outboundQueue)
      || state.outboundQueue.length > this.maxOutboundQueue
      || state.outboundQueue.some((packet) => typeof packet.deliveryId !== "string")
      || new Set(state.outboundQueue.map((packet) => packet.deliveryId)).size !== state.outboundQueue.length
      || state.outboundQueue.reduce((bytes, packet) => bytes + serializedBytes(packet), 0) > this.maxOutboundQueueBytes
    )) throw new Error("Stored client-ack replay violates queue limits or identities.");
    const outboundQueue = Array.isArray(state.outboundQueue)
      ? [...state.outboundQueue].slice(-this.maxOutboundQueue)
      : [];
    let outboundQueueBytes = outboundQueue.reduce(
      (total, packet) => total + serializedBytes(packet),
      0,
    );
    if (!Number.isFinite(outboundQueueBytes)) {
      outboundQueue.length = 0;
      outboundQueueBytes = 0;
    }
    while (outboundQueue.length > 0 && outboundQueueBytes > this.maxOutboundQueueBytes) {
      const removed = outboundQueue.shift();
      if (removed !== undefined) {
        outboundQueueBytes -= serializedBytes(removed);
      }
    }
    return {
      ...state,
      context: cloneSocketContext(state.context ?? {}),
      rooms: Array.isArray(state.rooms) ? this.normalizeRooms(state.rooms) : [],
      outboundQueue,
      revision: nonNegativeInteger(state.revision, 0),
      ttlMs,
      outboundQueueBytes: Math.max(0, outboundQueueBytes),
    };
  }

  private async refreshLocalFromAdapter(state: SessionState, signal?: AbortSignal): Promise<SessionState> {
    if (!this.adapter) {
      return state;
    }
    const loaded = await this.adapter.loadSession(state.sid);
    signal?.throwIfAborted();
    if (!loaded) {
      return state;
    }
    if (loaded.sid !== state.sid) {
      throw new Error("WebSocket adapter returned a mismatched session id.");
    }
    const remote = this.normalizeLoadedState(loaded);
    if ((remote.revision ?? 0) < (state.revision ?? 0)) {
      return state;
    }
    const previousRooms = state.rooms;
    Object.assign(state, remote);
    this.replaceRoomIndex(state, previousRooms);
    return state;
  }

  private normalizeRooms(rooms: Iterable<unknown>): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const room of rooms) {
      if (
        typeof room !== "string"
        || room.length === 0
        || room.length > this.maxRoomNameLength
        || room.includes(ROOM_SEPARATOR)
        || seen.has(room)
      ) {
        continue;
      }
      seen.add(room);
      normalized.push(room);
      if (normalized.length >= this.maxRoomsPerSession) {
        break;
      }
    }
    return normalized;
  }

  private enqueueOutboundState(state: SessionState, original: ServerPacket): boolean {
    const packet = state.replayDelivery === "client-ack"
      ? { ...original, deliveryId: crypto.randomUUID() } : original;
    const packetBytes = serializedBytes(packet);
    if (packetBytes > this.maxOutboundQueueBytes) {
      return false;
    }
    if (state.replayDelivery === "client-ack" && (
      state.outboundQueue.length >= this.maxOutboundQueue
      || (state.outboundQueueBytes ?? 0) + packetBytes > this.maxOutboundQueueBytes
    )) return false;
    state.outboundQueue.push(packet);
    state.outboundQueueBytes = (state.outboundQueueBytes ?? 0) + packetBytes;
    while (
      state.outboundQueue.length > this.maxOutboundQueue
      || (state.outboundQueueBytes ?? 0) > this.maxOutboundQueueBytes
    ) {
      const removed = state.outboundQueue.shift();
      if (removed !== undefined) {
        state.outboundQueueBytes = Math.max(0, (state.outboundQueueBytes ?? 0) - serializedBytes(removed));
      }
    }
    state.lastSeenAt = Date.now();
    this.bumpAndSave(state);
    return true;
  }

  private bumpAndSave(state: SessionState): void {
    const expectedRevision = state.revision ?? 0;
    state.revision = expectedRevision + 1;
    this.enqueueSave(state, expectedRevision, true);
  }

  private enqueueSave(state: SessionState, expectedRevision?: number, requireMatch = false): Promise<boolean> {
    if (!this.adapter) {
      return Promise.resolve(true);
    }
    const snapshot = structuredClone(state);
    return this.enqueuePersistence(state.sid, async () => {
      if (expectedRevision !== undefined && this.adapter?.compareAndSwapSession) {
        const saved = await this.adapter.compareAndSwapSession(snapshot, expectedRevision);
        if (!saved && requireMatch) {
          if (this.sessions.get(state.sid) === state) this.removeLocalSession(state);
          throw new Error("WebSocket session revision conflict.");
        }
        return saved;
      }
      await this.adapter?.saveSession(snapshot);
      return true;
    });
  }

  private enqueueDelete(sid: string, revision?: number): void {
    if (!this.adapter) {
      return;
    }
    void this.enqueuePersistence(sid, async () => {
      await this.adapter?.deleteSession(sid, revision);
      return true;
    });
  }

  private enqueuePersistence<T>(sid: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.persistenceTails.get(sid) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tail = next.then(() => undefined);
    this.persistenceTails.set(sid, tail);
    void tail.catch((error: unknown) => {
      this.persistenceErrors.set(sid, error);
    });
    void tail.finally(() => {
      if (this.persistenceTails.get(sid) === tail) {
        this.persistenceTails.delete(sid);
      }
    }).catch(() => {});
    return next;
  }

  private expireStaleLease(state: SessionState, now = Date.now()): void {
    if (!state.activeConnId) {
      return;
    }
    const leaseExpiresAt = state.activeLeaseExpiresAt ?? state.lastSeenAt + this.activeLeaseMs;
    if (now <= leaseExpiresAt) {
      state.activeLeaseExpiresAt = leaseExpiresAt;
      return;
    }
    state.activeConnId = undefined;
    state.ownerInstanceId = undefined;
    state.activeLeaseExpiresAt = undefined;
    this.bumpAndSave(state);
  }

  private isActive(state: SessionState, now = Date.now()): boolean {
    return state.activeConnId !== undefined && (state.activeLeaseExpiresAt ?? 0) > now;
  }

  private ttlOf(state: SessionState): number {
    return positiveInteger(state.ttlMs, this.defaultTtlMs);
  }

  private ensureSessionCapacity(sid?: string): void {
    if ((sid !== undefined && this.sessions.has(sid)) || this.sessions.size < this.maxSessions) {
      return;
    }
    throw new SessionCapacityError(this.maxSessions);
  }

  private replaceRoomIndex(state: SessionState, previousRooms: readonly string[]): void {
    this.removeRoomsFromIndex(state.sid, state.namespace, previousRooms);
    this.addRoomIndex(state);
  }

  private addRoomIndex(state: SessionState): void {
    for (const room of state.rooms) {
      const key = roomKey(state.namespace, room);
      let members = this.roomMembers.get(key);
      if (!members) {
        members = new Set<string>();
        this.roomMembers.set(key, members);
      }
      members.add(state.sid);
    }
  }

  private removeRoomIndex(state: SessionState): void {
    this.removeRoomsFromIndex(state.sid, state.namespace, state.rooms);
  }

  private removeRoomsFromIndex(sid: string, namespace: string, rooms: readonly string[]): void {
    for (const room of rooms) {
      const key = roomKey(namespace, room);
      const members = this.roomMembers.get(key);
      members?.delete(sid);
      if (members?.size === 0) {
        this.roomMembers.delete(key);
      }
    }
  }

  private removeLocalSession(state: SessionState): void {
    this.sessions.delete(state.sid);
    this.removeRoomIndex(state);
  }
}

function roomKey(namespace: string, room: string): string {
  return `${namespace}${ROOM_SEPARATOR}${room}`;
}

function serializedBytes(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function cloneSocketContext(context: SocketContext): SocketContext {
  return {
    ...context,
    ...(context.user ? { user: { ...context.user } } : {}),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
