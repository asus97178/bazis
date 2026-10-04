import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import {
  composeWsUpgradeMiddleware,
  createOriginCheckMiddleware,
  createWsAuthMiddleware,
  isValidSocketUser,
  WsUpgradeError,
  type WsAccessTokenAuthenticator,
  type WsUpgradeContext,
} from "./middleware";
import {
  hasHandleConnection,
  hasHandleDisconnect,
  hasOnGatewayInit,
  hasOnGatewayShutdown,
  type ClientPacket,
  type ReconnectPacketData,
  type ServerPacket,
  type SocketContext,
  type SocketUser,
  type ReplayDelivery,
} from "./types";
import type { RegisteredNamespace } from "./explorer";
import { PacketCodecError } from "./packet-codec";
import { dispatchWsHandler, WsDispatchError } from "./ws-dispatch";
import {
  applySessionToConnection,
  createConnectionData,
  detachRoomSubscriptions,
  restoreRoomSubscriptions,
  trySendPayload,
  wrapSocket,
  type WsConnectionData,
} from "./socket-wrapper";
import { TopicCache } from "./topic-cache";
import { SessionCapacityError, SessionManager, type SessionState } from "./session-manager";
import { WsRateLimiter } from "./WsRateLimiter";
import type { WebSocketAdapter } from "./adapter/adapter.interface";
import { InMemoryWebSocketAdapter } from "./adapter/in-memory.adapter";
import type { PacketCodec } from "./codec/packet-codec.interface";
import { payloadToBytes, payloadToText } from "./codec/packet-codec.interface";
import { jsonPacketCodec } from "./codec/json.codec";
import { WebSocketDeliveryError, type WebSocketDiagnostic, type ReliableSessionOwner } from "./reliable-delivery";

export interface WebSocketMemoryLimits {
  readonly maxRateLimitBuckets?: number;
  readonly maxTopics?: number;
  readonly maxSessions?: number;
  readonly maxRoomsPerSession?: number;
  readonly maxRoomNameLength?: number;
  readonly maxOutboundQueuePerSession?: number;
  readonly maxOutboundQueueBytesPerSession?: number;
  readonly maxOfflineBroadcastRecipients?: number;
  readonly maxOfflineBroadcastBytes?: number;
  /** Unsettled upgrade operations, including work that outlives its timeout. */
  readonly maxConcurrentHandshakes?: number;
  /** Complete upgrade and connection initialization deadline. Default 10s; 0 disables it. */
  readonly handshakeTimeoutMs?: number;
  readonly maxHandshakeAttemptsPerWindow?: number;
  readonly handshakeWindowMs?: number;
  readonly maxIngressPacketsPerWindow?: number;
  readonly ingressWindowMs?: number;
  readonly maxControlFramesPerWindow?: number;
  readonly controlFrameWindowMs?: number;
  readonly maxPendingMessagesPerConnection?: number;
  /** Unsettled validators/handlers, including work that outlives its timeout. */
  readonly maxConcurrentMessageHandlers?: number;
  /** Validator + handler deadline per message. Default 30s; 0 disables it. */
  readonly messageHandlingTimeoutMs?: number;
  /** Total graceful shutdown drain budget. Default 5s; 0 disables it. */
  readonly shutdownDrainTimeoutMs?: number;
  readonly activeSessionLeaseMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly maxSessionIdLength?: number;
  readonly maxEventNameLength?: number;
  readonly maxPacketIdLength?: number;
  /** Native per-socket outgoing buffer bound. Default 1 MiB. */
  readonly maxBackpressureBytes?: number;
  readonly socketCloseTimeoutMs?: number;
  readonly reliablePollIntervalMs?: number;
}

export interface WebSocketServerOptions {
  namespaces: RegisteredNamespace[];
  authenticator?: WsAccessTokenAuthenticator | null;
  requireAuth?: boolean;
  allowQueryToken?: boolean;
  defaultCorsOrigins?: string[];
  adapter?: WebSocketAdapter;
  codec?: PacketCodec;
  replayDelivery?: ReplayDelivery;
  onDiagnostic?: (event: WebSocketDiagnostic) => void;
  limits?: WebSocketMemoryLimits;
  /** Expose validator/handler exception messages. Disabled by default. */
  exposeHandlerErrors?: boolean;
}

export interface WebSocketServerStats {
  readonly activeConnections: number;
  readonly sessions: number;
  readonly queuedMessages: number;
  readonly topics: number;
  readonly rateLimitBuckets: number;
  readonly delivery: Readonly<Record<WebSocketDiagnostic["type"], number>>;
}

interface MessageQueue {
  tail: Promise<void>;
  pending: number;
}

class SessionOwnershipError extends Error {
  public constructor() {
    super("WebSocket session is already active.");
    this.name = "SessionOwnershipError";
  }
}

function parseReconnectSid(packet: ClientPacket): string | null {
  if (packet.type !== "reconnect") {
    return null;
  }
  const data = packet.data as ReconnectPacketData | undefined;
  return data && typeof data.sid === "string" && data.sid.length > 0 ? data.sid : null;
}

/** Native Bun WebSocket runtime shared with the HTTP listener. */
export class WebSocketServer {
  private readonly namespacesByPath = new Map<string, RegisteredNamespace>();
  private readonly namespacesByName = new Map<string, RegisteredNamespace>();
  private readonly topics: TopicCache;
  private readonly sessionManager: SessionManager;
  private readonly adapter: WebSocketAdapter;
  private readonly codec: PacketCodec;
  private readonly handlerRateLimiter: WsRateLimiter;
  private readonly handshakeRateLimiter: WsRateLimiter;
  private readonly ingressRateLimiter: WsRateLimiter;
  private readonly controlRateLimiter: WsRateLimiter;
  private readonly limits: Required<WebSocketMemoryLimits>;
  private readonly rateLimitKeysBySid = new Map<string, Set<string>>();
  private readonly connectionsBySid = new Map<string, ServerWebSocket<WsConnectionData>>();
  private readonly physicalSockets = new Set<ServerWebSocket<WsConnectionData>>();
  private readonly messageQueues = new Map<string, MessageQueue>();
  private readonly openOperations = new Map<string, Promise<void>>();
  private readonly drainWaiters = new Map<string, () => void>();
  private readonly closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingOperations = new Set<Promise<void>>();
  private readonly pendingWork = new Set<Promise<void>>();
  private readonly connectionWork = new Map<string, Promise<void>>();
  private readonly pendingAdapterOperations = new Set<Promise<void>>();
  private readonly handshakeControllers = new Set<AbortController>();
  private readonly messageControllers = new Map<string, AbortController>();
  private readonly initializedGateways: unknown[] = [];
  private readonly maxPayloadLength: number;
  private activeConnections = 0;
  private activeHandshakes = 0;
  private activeMessageHandlers = 0;
  private leaseRenewalInFlight = false;
  private bunServer: Server<WsConnectionData> | null = null;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private deliveryTimer?: ReturnType<typeof setInterval>;
  private readonly deliveryCandidates = new Set<string>();
  private deliveryInFlight = false;
  private readonly deliveryCounters: Record<WebSocketDiagnostic["type"], number> = {
    "queue-rejected": 0, "adapter-error": 0, "lease-lost": 0, "reliable-published": 0,
    "reliable-rejected": 0, "reliable-acked": 0, "poll-error": 0,
  };
  private adapterOperationError: unknown;
  private initialized = false;
  private closed = false;
  private closing?: Promise<void>;

  public constructor(private readonly options: WebSocketServerOptions) {
    validateAuthenticatedOrigins(options);
    if (options.replayDelivery !== undefined && options.replayDelivery !== "transport" && options.replayDelivery !== "client-ack") {
      throw new Error("WebSocket replayDelivery must be transport or client-ack.");
    }
    this.limits = normalizeMemoryLimits(options.limits);
    if (this.limits.leaseRenewIntervalMs >= this.limits.activeSessionLeaseMs) {
      throw new Error("WebSocket leaseRenewIntervalMs must be less than activeSessionLeaseMs.");
    }
    this.topics = new TopicCache({ maxTopics: this.limits.maxTopics });
    this.handlerRateLimiter = new WsRateLimiter({ maxBuckets: this.limits.maxRateLimitBuckets });
    this.handshakeRateLimiter = new WsRateLimiter({ maxBuckets: this.limits.maxRateLimitBuckets });
    this.ingressRateLimiter = new WsRateLimiter({ maxBuckets: this.limits.maxRateLimitBuckets });
    this.controlRateLimiter = new WsRateLimiter({ maxBuckets: this.limits.maxRateLimitBuckets });

    let maxPayload = 1;
    for (const namespace of options.namespaces) {
      validateNamespace(namespace);
      if (this.namespacesByPath.has(namespace.path)) {
        throw new Error(`Duplicate WebSocket path "${namespace.path}".`);
      }
      if (this.namespacesByName.has(namespace.namespace)) {
        throw new Error(`Duplicate WebSocket namespace "${namespace.namespace}".`);
      }
      this.namespacesByPath.set(namespace.path, namespace);
      this.namespacesByName.set(namespace.namespace, namespace);
      maxPayload = Math.max(maxPayload, namespace.maxPayloadBytes);
    }
    this.maxPayloadLength = maxPayload;
    this.adapter = options.adapter ?? new InMemoryWebSocketAdapter({ maxEntries: this.limits.maxSessions });
    this.codec = options.codec ?? jsonPacketCodec;
    this.sessionManager = new SessionManager({
      adapter: this.adapter,
      maxOutboundQueue: this.limits.maxOutboundQueuePerSession,
      maxOutboundQueueBytes: this.limits.maxOutboundQueueBytesPerSession,
      maxSessions: this.limits.maxSessions,
      maxRoomsPerSession: this.limits.maxRoomsPerSession,
      maxRoomNameLength: this.limits.maxRoomNameLength,
      maxOfflineBroadcastRecipients: this.limits.maxOfflineBroadcastRecipients,
      maxOfflineBroadcastBytes: this.limits.maxOfflineBroadcastBytes,
      activeLeaseMs: this.limits.activeSessionLeaseMs,
    });
  }

  public getStats(): WebSocketServerStats {
    const sessionStats = this.sessionManager.getStats();
    return {
      activeConnections: this.activeConnections,
      sessions: sessionStats.sessions,
      queuedMessages: sessionStats.queuedMessages,
      topics: this.topics.getStats().topics,
      delivery: { ...this.deliveryCounters },
      rateLimitBuckets:
        this.handlerRateLimiter.getStats().buckets
        + this.handshakeRateLimiter.getStats().buckets
        + this.ingressRateLimiter.getStats().buckets
        + this.controlRateLimiter.getStats().buckets,
    };
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.closed) {
      throw new Error("WebSocket server is closed.");
    }
    try {
      await this.adapter.initialize({
        localPublish: (topic, payload) => {
          this.bunServer?.publish(topic, this.codec.isBinary(payload) ? payload : payloadToText(payload));
        },
        deliveriesReady: (sids) => this.queueDeliveries(sids),
      });
      for (const namespace of this.options.namespaces) {
        // Register before invoking the hook so a partially initialized gateway
        // still receives rollback shutdown when its init hook throws.
        this.initializedGateways.push(namespace.gatewayInstance);
        if (hasOnGatewayInit(namespace.gatewayInstance)) {
          await namespace.gatewayInstance.onGatewayInit();
        }
      }
      this.initialized = true;
      if (this.adapter.reliableRooms) {
        this.deliveryTimer = setInterval(() => this.queueDeliveries(this.connectionsBySid.keys()), this.limits.reliablePollIntervalMs);
      }
      const leaseSpreadMs = Math.min(this.limits.leaseRenewIntervalMs,
        Math.floor((this.limits.activeSessionLeaseMs - this.limits.leaseRenewIntervalMs) / 2));
      const leaseTickMs = Math.max(1, Math.min(1000, Math.floor(this.limits.leaseRenewIntervalMs / 10),
        Math.floor(Math.min(...this.options.namespaces.map((namespace) => namespace.sessionTtlMs)) / 10)));
      this.leaseTimer = setInterval(() => {
        if (this.leaseRenewalInFlight || this.closed) {
          return;
        }
        this.leaseRenewalInFlight = true;
        const renewal = this.sessionManager.renewOwnedLeases({ afterMs: this.limits.leaseRenewIntervalMs, spreadMs: leaseSpreadMs })
          .then((lostSids) => {
            if (lostSids.length) this.diagnose("lease-lost", lostSids.length);
            for (const sid of lostSids) {
              const ws = this.connectionsBySid.get(sid);
              if (ws) this.closeConnection(ws, 4009, "session ownership lost");
            }
          })
          .catch((error: unknown) => {
            this.diagnose("adapter-error");
            // If lease persistence is unavailable, fail closed before another
            // node can legitimately claim an apparently expired session.
            for (const ws of this.connectionsBySid.values()) {
              this.closeConnection(ws, 1011, "session lease renewal failed");
            }
            throw error;
          })
          .finally(() => {
            this.leaseRenewalInFlight = false;
          });
        this.trackOperation(renewal);
      }, leaseTickMs);
    } catch (error) {
      await this.shutdownInitializedGateways().catch(() => {});
      await this.adapter.close().catch(() => {});
      this.closed = true;
      throw error;
    }
  }

  public async tryUpgrade(
    request: Request,
    server: Server<WsConnectionData>,
  ): Promise<Response | undefined | null> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return null;
    }
    const url = new URL(request.url);
    const registered = this.namespacesByPath.get(url.pathname);
    if (!registered) {
      return null;
    }
    if (this.closed || !this.initialized) {
      return new Response("WebSocket service unavailable", { status: 503 });
    }
    this.bunServer = server;

    const address = requestAddress(server, request);
    const handshakeKey = `${address}:${registered.path}`;
    if (!this.handshakeRateLimiter.check(
      handshakeKey,
      this.limits.maxHandshakeAttemptsPerWindow,
      this.limits.handshakeWindowMs,
    )) {
      return new Response("Too many WebSocket upgrade attempts", { status: 429 });
    }
    if (this.activeHandshakes >= this.limits.maxConcurrentHandshakes) {
      return new Response("WebSocket service busy", { status: 503 });
    }

    this.activeHandshakes += 1;
    const handshakeController = new AbortController();
    this.handshakeControllers.add(handshakeController);
    const work = this.observeWork(
      () => this.performUpgrade(request, server, url, registered, handshakeController.signal),
      () => {
        this.handshakeControllers.delete(handshakeController);
        this.activeHandshakes -= 1;
      },
    );
    try {
      return await runAbortable(
        () => work,
        handshakeController,
        this.limits.handshakeTimeoutMs,
        "WebSocket upgrade timed out.",
      );
    } catch (error) {
      if (error instanceof WsUpgradeError) {
        return new Response(error.message, { status: error.status });
      }
      if (error instanceof WebSocketOperationTimeoutError) {
        return new Response("WebSocket upgrade timed out", { status: 504 });
      }
      if (handshakeController.signal.aborted && this.closed) {
        return new Response("WebSocket service unavailable", { status: 503 });
      }
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
  }

  private async performUpgrade(
    request: Request,
    server: Server<WsConnectionData>,
    url: URL,
    registered: RegisteredNamespace,
    signal: AbortSignal,
  ): Promise<Response | undefined> {
    const corsOrigins =
      registered.corsOrigins.length > 0
        ? registered.corsOrigins
        : (this.options.defaultCorsOrigins ?? ["*"]);
    const middlewares = [
      createOriginCheckMiddleware(corsOrigins),
      ...(this.options.authenticator
        ? [createWsAuthMiddleware(this.options.authenticator, {
            required: this.options.requireAuth,
            allowQueryToken: this.options.allowQueryToken,
          })]
        : []),
      ...registered.middleware,
    ];
    const ctx: WsUpgradeContext = {
      request,
      namespace: registered.namespace,
      path: registered.path,
      signal,
      data: {},
    };

    await composeWsUpgradeMiddleware(middlewares, async () => {})(ctx);
    throwIfAborted(signal);
    if (this.closed) {
      return new Response("WebSocket service unavailable", { status: 503 });
    }

    const upgradeUser = (ctx.data as { user?: unknown }).user;
    if (upgradeUser !== undefined && !isValidSocketUser(upgradeUser)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const sidParam = url.searchParams.get("sid");
    const requestedReplay = url.searchParams.get("replay");
    if (url.searchParams.getAll("replay").length > 1 || (requestedReplay !== null && requestedReplay !== "transport" && requestedReplay !== "client-ack")) {
      return new Response("Invalid replay delivery mode", { status: 400 });
    }
    const replayDelivery = requestedReplay ?? this.options.replayDelivery ?? "transport";
    if (this.options.replayDelivery === "client-ack" && replayDelivery !== "client-ack") {
      return new Response("Client replay acknowledgement required", { status: 409 });
    }
    if (replayDelivery === "client-ack" && !this.adapter.compareAndSwapSession) {
      return new Response("Replay acknowledgement requires an atomic session adapter", { status: 503 });
    }
    let connectionData: WsConnectionData;
    if (sidParam !== null) {
      if (sidParam.length === 0 || sidParam.length > this.limits.maxSessionIdLength) {
        return new Response("Invalid session id", { status: 400 });
      }
      let session: SessionState | undefined;
      try {
        session = await this.sessionManager.resolveSession(sidParam, signal);
        throwIfAborted(signal);
      } catch (error) {
        return new Response(
          error instanceof SessionCapacityError ? "WebSocket session capacity exceeded" : "Session lookup failed",
          { status: error instanceof SessionCapacityError ? 503 : 500 },
        );
      }
      if (!session || session.namespace !== registered.namespace) {
        return new Response("Session not found", { status: 404 });
      }
      const storedUser = session.context.user;
      if (storedUser !== undefined && !isValidSocketUser(storedUser)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const user = upgradeUser as SocketUser | undefined;
      if (storedUser && user?.id !== storedUser.id) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (session.replayDelivery === "client-ack" && replayDelivery !== "client-ack") {
        return new Response("Client replay acknowledgement required", { status: 409 });
      }
      if (user) {
        session.context.user = cloneSocketUser(user);
        this.sessionManager.updateContext(session.sid, session.context);
        await this.sessionManager.flushSession(session.sid);
        throwIfAborted(signal);
      }
      connectionData = createConnectionData(registered.namespace, { ...session.context }, session.sid, replayDelivery);
      connectionData.rooms = new Set(session.rooms);
      connectionData.isReconnect = true;
    } else {
      if (!this.sessionManager.hasCapacity()) {
        return new Response("WebSocket session capacity exceeded", { status: 503 });
      }
      connectionData = createConnectionData(registered.namespace, { ...(ctx.data as SocketContext) }, undefined, replayDelivery);
    }

    if (this.closed) {
      return new Response("WebSocket service unavailable", { status: 503 });
    }

    return server.upgrade(request, { data: connectionData })
      ? undefined
      : new Response("WebSocket upgrade failed", { status: 500 });
  }

  public createBunHandler(): WebSocketHandler<WsConnectionData> {
    return {
      maxPayloadLength: this.maxPayloadLength,
      backpressureLimit: this.limits.maxBackpressureBytes,
      closeOnBackpressureLimit: true,
      open: (ws) => {
        this.physicalSockets.add(ws);
        const opening = this.handleOpenSafely(ws);
        this.openOperations.set(ws.data.connId, opening);
        this.trackOperation(opening.finally(() => {
          if (this.openOperations.get(ws.data.connId) === opening) {
            this.openOperations.delete(ws.data.connId);
          }
          this.queueDeliveries([ws.data.sid]);
        }));
      },
      message: (ws, message) => this.enqueueMessage(ws, message),
      drain: (ws) => { this.drainWaiters.get(ws.data.connId)?.(); this.queueDeliveries([ws.data.sid]); },
      close: (ws, _code, reason) => {
        this.physicalSockets.delete(ws);
        this.trackOperation(this.handleCloseSafely(ws, reason));
      },
    };
  }

  public close(): Promise<void> {
    // Every caller observes the same result, including a previous drain timeout.
    return this.closing ??= this.closeRuntime();
  }

  private async closeRuntime(): Promise<void> {
    if (this.closed && !this.initialized) return;
    this.closed = true;
    if (this.deliveryTimer !== undefined) clearInterval(this.deliveryTimer);
    this.deliveryTimer = undefined;
    this.deliveryCandidates.clear();
    if (this.leaseTimer !== undefined) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;

    const deadline = this.limits.shutdownDrainTimeoutMs === 0
      ? null : Date.now() + this.limits.shutdownDrainTimeoutMs;
    this.abortMessageOperations("WebSocket server is shutting down.");
    for (const controller of this.handshakeControllers) {
      controller.abort(new WebSocketOperationAbortedError("WebSocket server is shutting down."));
    }
    for (const ws of this.physicalSockets) {
      ws.data.lifetimeController.abort(new WebSocketOperationAbortedError("WebSocket server is shutting down."));
    }

    // Stop transport immediately. Disconnect hooks wait for their connection's
    // actual work; neither a timeout nor a closed socket completes that work.
    const sockets = [...this.physicalSockets];
    let cursor = 0;
    this.trackOperation(Promise.all(Array.from({ length: Math.min(16, sockets.length) }, async () => {
      while (cursor < sockets.length) await this.handleCloseSafely(sockets[cursor++]!, "server shutdown");
    })).then(() => {}));
    for (const ws of sockets) ws.terminate();
    for (const timer of this.closeTimers.values()) clearTimeout(timer);
    this.closeTimers.clear();

    // Continue ordered cleanup after a public timeout, but do not close the
    // gateway/adapter underneath unresolved application callbacks.
    const cleanup = this.finishClose();
    if (!await settleBeforeDeadline(() => cleanup, deadline)) {
      throw new WebSocketOperationTimeoutError("WebSocket shutdown timed out; cleanup remains pending.");
    }
  }

  private async finishClose(): Promise<void> {
    while (this.pendingWork.size > 0) await Promise.all([...this.pendingWork]);
    await this.awaitPendingOperations();
    const errors: unknown[] = [];
    for (const cleanup of [
      () => this.sessionManager.flushAll(),
      () => this.awaitPendingAdapterOperations(),
      () => this.shutdownInitializedGateways(),
      () => this.adapter.close(),
    ]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }

    this.initialized = false;
    this.connectionsBySid.clear();
    this.physicalSockets.clear();
    this.messageQueues.clear();
    this.openOperations.clear();
    this.drainWaiters.clear();
    this.topics.clear();
    this.rateLimitKeysBySid.clear();
    this.handlerRateLimiter.clear();
    this.handshakeRateLimiter.clear();
    this.ingressRateLimiter.clear();
    this.controlRateLimiter.clear();
    this.handshakeControllers.clear();
    this.messageControllers.clear();
    this.activeConnections = 0;
    this.bunServer = null;
    if (this.adapterOperationError !== undefined) {
      errors.push(this.adapterOperationError);
      this.adapterOperationError = undefined;
    }
    if (errors.length > 0) throw errors[0];
  }

  private wrapOptions(
    ws: ServerWebSocket<WsConnectionData>,
    signal?: AbortSignal,
  ): Parameters<typeof wrapSocket>[2] {
    const registered = this.resolveNamespace(ws);
    const maxPayloadBytes = registered ? outboundLimit(registered) : this.maxPayloadLength;
    return {
      codec: this.codec,
      ...(signal ? { signal } : {}),
      maxRoomNameLength: this.limits.maxRoomNameLength,
      maxRoomsPerSession: this.limits.maxRoomsPerSession,
      disconnect: (code, reason) => this.closeConnection(ws, code, reason),
      send: (payload) => {
        if (signal?.aborted) {
          return;
        }
        if (payloadBytes(payload) > maxPayloadBytes) {
          throw new Error("WebSocket outbound payload exceeds the namespace limit.");
        }
        if (!trySendPayload(ws, payload)) {
          this.closeForOutbound(ws, 1011, "outbound send failed");
        }
      },
      broadcast: (room, packet) => {
        if (signal?.aborted) {
          return;
        }
        const namespace = ws.data.namespace;
        const topic = this.topics.get(namespace, room);
        const payload = this.codec.encodeServer(packet);
        const bytes = payloadToBytes(payload);
        if (bytes.byteLength > maxPayloadBytes) {
          throw new Error("WebSocket broadcast payload exceeds the namespace limit.");
        }
        const admission = this.sessionManager.enqueueToOfflineRoomMembers(
          namespace,
          room,
          { v: 1, ...packet },
          ws.data.sid,
          bytes.byteLength,
          true,
        );
        if (admission.truncated) {
          this.diagnose("queue-rejected");
          throw new WebSocketDeliveryError("OFFLINE_QUEUE_CAPACITY");
        }
        ws.publish(topic, payload);
        this.trackAdapterOperation(this.adapter.publish(topic, bytes));
      },
      broadcastReliable: async (room, packet, options) => {
        signal?.throwIfAborted();
        const store = this.adapter.reliableRooms;
        if (!store) throw new WebSocketDeliveryError("RELIABLE_DELIVERY_UNAVAILABLE");
        if (payloadBytes(this.codec.encodeServer({ ...packet, deliveryId: options.messageId })) > maxPayloadBytes) {
          throw new WebSocketDeliveryError("PAYLOAD_CAPACITY");
        }
        try {
          // Joining a room and publishing in one handler is an ordered operation.
          await this.sessionManager.flushSession(ws.data.sid);
          signal?.throwIfAborted();
          const receipt = await store.publish({ ...options, namespace: ws.data.namespace, room, excludeSid: ws.data.sid, packet: { ...packet, v: 1 } });
          this.diagnose("reliable-published", receipt.duplicate ? 0 : receipt.recipients);
          signal?.throwIfAborted();
          return receipt;
        } catch (error) {
          this.diagnose("reliable-rejected");
          throw error;
        }
      },
      onRoomsChanged: (sid, rooms) => {
        // A replaced physical socket may still run its disconnect hook after a
        // new socket has claimed the same SID. Never let that stale wrapper
        // overwrite the new owner's room snapshot.
        if (this.connectionsBySid.get(sid) === ws) {
          this.sessionManager.updateRooms(sid, rooms);
        }
      },
    };
  }

  private encodeSend(
    ws: ServerWebSocket<WsConnectionData>,
    packet: Omit<ServerPacket, "v"> & { v?: 1 },
  ): boolean {
    const payload = this.codec.encodeServer(packet);
    const registered = this.resolveNamespace(ws);
    if (registered && payloadBytes(payload) > outboundLimit(registered)) {
      this.closeForOutbound(ws, 1009, "outbound payload too large");
      return false;
    }
    if (!trySendPayload(ws, payload)) {
      this.closeForOutbound(ws, 1011, "outbound send failed");
      return false;
    }
    return true;
  }

  private closeForOutbound(ws: ServerWebSocket<WsConnectionData>, code: number, reason: string): void {
    this.closeConnection(ws, code, reason);
  }

  private closeConnection(ws: ServerWebSocket<WsConnectionData>, code: number, reason: string): void {
    ws.data.messageProcessingStopped = true;
    const error = new WebSocketOperationAbortedError(reason);
    ws.data.lifetimeController.abort(error);
    this.messageControllers.get(ws.data.connId)?.abort(error);
    ws.close(code, reason);
    if (ws.data.closed || this.closeTimers.has(ws.data.connId)) return;
    const timer = setTimeout(() => {
      this.closeTimers.delete(ws.data.connId);
      if (!ws.data.closed) ws.terminate();
    }, this.limits.socketCloseTimeoutMs);
    this.closeTimers.set(ws.data.connId, timer);
  }

  private sendError(ws: ServerWebSocket<WsConnectionData>, message: string, id?: string, code?: string): void {
    this.encodeSend(ws, { type: "error", data: { message, ...(code ? { code } : {}) }, ...(id !== undefined ? { id } : {}) });
  }

  private resolveNamespace(ws: ServerWebSocket<WsConnectionData>): RegisteredNamespace | undefined {
    return this.namespacesByName.get(ws.data.namespace);
  }

  private async handleOpenSafely(ws: ServerWebSocket<WsConnectionData>): Promise<void> {
    const work = this.observeWork(() => this.handleOpen(ws), undefined, ws.data.connId);
    try {
      await runAbortable(
        () => work,
        ws.data.lifetimeController,
        this.limits.handshakeTimeoutMs,
        "WebSocket connection initialization timed out.",
      );
    } catch (error) {
      ws.data.messageProcessingStopped = true;
      ws.data.lifetimeController.abort(error);
      const code = error instanceof SessionCapacityError ? 1013 : error instanceof SessionOwnershipError ? 4009 : 1011;
      const reason = error instanceof SessionCapacityError
        ? "session capacity exceeded"
        : error instanceof SessionOwnershipError
          ? "session already active"
          : "connection initialization failed";
      this.closeConnection(ws, code, reason);
    }
  }

  private async handleOpen(ws: ServerWebSocket<WsConnectionData>): Promise<void> {
    const signal = ws.data.lifetimeController.signal;
    throwIfAborted(signal);
    const registered = this.resolveNamespace(ws);
    if (!registered || this.closed) {
      this.closeConnection(ws, 1011, "Unknown namespace");
      return;
    }

    let session: SessionState;
    if (ws.data.isReconnect) {
      const resolved = await this.sessionManager.resolveSession(ws.data.sid, signal);
      throwIfAborted(signal);
      if (!resolved || resolved.namespace !== registered.namespace
        || (resolved.replayDelivery === "client-ack" && ws.data.replayDelivery !== "client-ack")) {
        throw new SessionOwnershipError();
      }
      session = resolved;
      applySessionToConnection(ws, session.sid, session.context, session.rooms);
    } else {
      session = this.sessionManager.createSession(
        ws.data.sid,
        ws.data.namespace,
        ws.data.context,
        registered.sessionTtlMs,
        ws.data.replayDelivery,
      );
    }

    await this.claimPhysicalConnection(ws, session.sid);
    throwIfAborted(signal);
    if (ws.data.replayDelivery === "client-ack") {
      this.sessionManager.enableReplayAcknowledgements(session.sid);
      await this.sessionManager.flushSession(session.sid);
      throwIfAborted(signal);
    }
    restoreRoomSubscriptions(ws, this.topics);
    ws.data.opened = true;
    this.activeConnections += 1;

    if (ws.data.isReconnect) {
      if (!await this.sendReconnect(ws, registered, signal)) return;
    } else {
      await this.sessionManager.flushSession(session.sid);
      throwIfAborted(signal);
      if (!this.encodeSend(ws, {
        type: "connected",
        sid: session.sid,
        namespace: session.namespace,
        data: { userId: session.context.user?.id },
        ...(ws.data.replayDelivery === "client-ack" ? { replayDelivery: "client-ack" as const } : {}),
      })) return;
    }

    if (hasHandleConnection(registered.gatewayInstance)) {
      await registered.gatewayInstance.handleConnection(
        wrapSocket(ws, this.topics, this.wrapOptions(ws, ws.data.lifetimeController.signal)),
      );
      throwIfAborted(signal);
      if (this.closed || ws.data.closed || this.connectionsBySid.get(session.sid) !== ws) {
        return;
      }
      await this.sessionManager.flushSession(session.sid);
    }
  }

  private async sendReconnect(
    ws: ServerWebSocket<WsConnectionData>,
    registered: RegisteredNamespace,
    signal: AbortSignal,
  ): Promise<boolean> {
    ws.data.replaying = true;
    try { return await this.sendReconnectFrames(ws, registered, signal); }
    finally { ws.data.replaying = false; this.queueDeliveries([ws.data.sid]); }
  }

  private async sendReconnectFrames(
    ws: ServerWebSocket<WsConnectionData>,
    registered: RegisteredNamespace,
    signal: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    const sid = ws.data.sid;
    const clientAck = ws.data.replayDelivery === "client-ack";
    const remote = clientAck && this.adapter.reliableRooms
      ? (await this.adapter.reliableRooms.readPending([this.deliveryOwner(ws)]))[0]?.packets ?? []
      : [];
    throwIfAborted(signal);
    const pending = [...this.sessionManager.peekOutbound(sid), ...remote];
    const remoteIds = new Set(remote.map((packet) => packet.deliveryId));
    ws.data.sentReplayIds = clientAck ? new Set<string>() : undefined;
    ws.data.sentReliableIds = clientAck ? new Set<string>() : undefined;
    const recordSent = (packet: ServerPacket): void => {
      if (remoteIds.has(packet.deliveryId)) ws.data.sentReliableIds!.add(packet.deliveryId!);
      else ws.data.sentReplayIds!.add(packet.deliveryId!);
    };
    const missed: ServerPacket[] = [];
    const frame: Omit<ServerPacket, "v"> = {
      type: "reconnected",
      sid,
      namespace: registered.namespace,
      missed,
      data: { userId: ws.data.context.user?.id },
      ...(clientAck ? { replayDelivery: "client-ack" as const, replayCount: pending.length } : {}),
    };
    for (const packet of pending) {
      const candidate = { ...frame, missed: [...missed, packet] };
      if (payloadBytes(this.codec.encodeServer(candidate)) > outboundLimit(registered)) {
        break;
      }
      missed.push(packet);
    }

    let accepted = 0;
    try {
      await this.waitForDrain(ws, signal);
      if (!this.encodeSend(ws, frame)) return false;
      accepted = missed.length;
      if (clientAck) for (const packet of missed) recordSent(packet);
      // A valid event may fit the namespace limit while not fitting inside
      // the reconnect envelope. Deliver the remainder in order; wait for
      // native drain rather than exhausting a healthy client's send buffer.
      for (const packet of pending.slice(missed.length)) {
        throwIfAborted(signal);
        if ((ws.getBufferedAmount?.() ?? 0) > 0) {
          if (!clientAck) this.sessionManager.acknowledgeOutbound(sid, accepted);
          accepted = 0;
          await this.waitForDrain(ws, signal);
        }
        if (!this.encodeSend(ws, packet)) return false;
        accepted += 1;
        if (clientAck) recordSent(packet);
      }
      return true;
    } finally {
      // Each transport prefix is committed before yielding to drain; a
      // replaced connection cannot remove a new owner's replay entries.
      if (!clientAck && this.connectionsBySid.get(sid) === ws) this.sessionManager.acknowledgeOutbound(sid, accepted);
      await this.sessionManager.flushSession(sid);
      throwIfAborted(signal);
    }
  }

  private async waitForDrain(ws: ServerWebSocket<WsConnectionData>, signal: AbortSignal): Promise<void> {
    while ((ws.getBufferedAmount?.() ?? 0) > 0) {
      throwIfAborted(signal);
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          signal.removeEventListener("abort", abort);
          if (this.drainWaiters.get(ws.data.connId) === drained) this.drainWaiters.delete(ws.data.connId);
        };
        // Let Bun finish its native drain callback before the next write batch.
        // Resuming inside that callback can stall subsequent buffered sends.
        const drained = (): void => { cleanup(); setImmediate(resolve); };
        const abort = (): void => { cleanup(); reject(signal.reason); };
        this.drainWaiters.set(ws.data.connId, drained);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else if ((ws.getBufferedAmount?.() ?? 0) === 0) drained();
      });
    }
    throwIfAborted(signal);
  }

  private async claimPhysicalConnection(
    ws: ServerWebSocket<WsConnectionData>,
    sid: string,
    signal: AbortSignal = ws.data.lifetimeController.signal,
  ): Promise<void> {
    const claimed = await this.sessionManager.claimActiveConnection(sid, ws.data.connId);
    if (!claimed) {
      throw new SessionOwnershipError();
    }
    if (this.closed || ws.data.closed || signal.aborted) {
      await this.sessionManager.releaseActiveConnection(sid, ws.data.connId, ws.data.rooms);
      throw new SessionOwnershipError();
    }
    const previous = this.connectionsBySid.get(sid);
    this.connectionsBySid.set(sid, ws);
    if (previous && previous !== ws) {
      previous.data.messageProcessingStopped = true;
      previous.data.lifetimeController.abort(
        new WebSocketOperationAbortedError("WebSocket session was replaced."),
      );
      this.messageControllers.get(previous.data.connId)?.abort(
        new WebSocketOperationAbortedError("WebSocket session was replaced."),
      );
      this.closeConnection(previous, 4009, "session replaced");
    }
  }

  private async handleReconnectMessage(
    ws: ServerWebSocket<WsConnectionData>,
    packet: ClientPacket,
    registered: RegisteredNamespace,
    signal: AbortSignal,
  ): Promise<void> {
    const targetSid = parseReconnectSid(packet);
    if (!targetSid || targetSid.length > this.limits.maxSessionIdLength) {
      this.sendError(ws, "Invalid reconnect session id", packet.id);
      return;
    }
    const session = await this.sessionManager.resolveSession(targetSid, signal);
    throwIfAborted(signal);
    if (!session || session.namespace !== registered.namespace) {
      this.sendError(ws, "Session not found or expired", packet.id);
      return;
    }
    if (session.context.user !== undefined && !isValidSocketUser(session.context.user)) {
      this.sendError(ws, "Unauthorized reconnect", packet.id);
      return;
    }
    if (session.replayDelivery === "client-ack" && ws.data.replayDelivery !== "client-ack") {
      this.sendError(ws, "Client replay acknowledgement required", packet.id);
      return;
    }

    const data = packet.data as ReconnectPacketData | undefined;
    let effectiveUser = ws.data.principal;
    let reauthenticatedUser: SocketUser | undefined;
    if (this.options.authenticator && data?.token) {
      const user = await this.options.authenticator(data.token, {
        signal,
        namespace: registered.namespace,
        path: registered.path,
      });
      throwIfAborted(signal);
      if (user !== null && !isValidSocketUser(user)) {
        this.sendError(ws, "Unauthorized reconnect", packet.id);
        return;
      }
      if (user !== null) {
        effectiveUser = user;
        reauthenticatedUser = user;
      } else {
        // An explicitly supplied but rejected credential cannot silently fall
        // back to a possibly stale connection principal.
        effectiveUser = undefined;
      }
    }

    // Session ownership is an invariant of the stored session, not of the
    // optional top-level authenticator. Gateway middleware may establish the
    // principal instead, and a socket that knows another user's SID must never
    // be allowed to rebind to it. A token above is only an additional reauth
    // mechanism which updates the effective current principal.
    if (session.context.user?.id && effectiveUser?.id !== session.context.user.id) {
      this.sendError(ws, "Unauthorized reconnect", packet.id);
      return;
    }
    if (reauthenticatedUser) {
      ws.data.principal = cloneSocketUser(reauthenticatedUser);
      ws.data.context.user = cloneSocketUser(reauthenticatedUser);
      session.context.user = cloneSocketUser(reauthenticatedUser);
      this.sessionManager.updateContext(session.sid, session.context);
    } else if (!session.context.user && effectiveUser) {
      // An authenticated physical connection adopts an anonymous session so
      // subsequent reconnects cannot silently downgrade it back to bearer-only.
      session.context.user = cloneSocketUser(effectiveUser);
      this.sessionManager.updateContext(session.sid, session.context);
    }

    const oldSid = ws.data.sid;
    if (oldSid !== session.sid) {
      if (this.connectionsBySid.get(oldSid) === ws) {
        this.connectionsBySid.delete(oldSid);
      }
      await this.sessionManager.releaseActiveConnection(oldSid, ws.data.connId, ws.data.rooms);
      throwIfAborted(signal);
      this.forgetRateLimitKeys(oldSid);
      detachRoomSubscriptions(ws, this.topics);
    }

    applySessionToConnection(ws, session.sid, session.context, session.rooms);
    try {
      await this.claimPhysicalConnection(ws, session.sid, signal);
      throwIfAborted(signal);
    } catch (error) {
      this.closeConnection(ws,
        error instanceof SessionOwnershipError ? 4009 : 1011,
        error instanceof SessionOwnershipError ? "session already active" : "session persistence failed",
      );
      return;
    }
    restoreRoomSubscriptions(ws, this.topics);
    if (ws.data.replayDelivery === "client-ack") {
      this.sessionManager.enableReplayAcknowledgements(session.sid);
      await this.sessionManager.flushSession(session.sid);
      throwIfAborted(signal);
    }
    if (!await this.sendReconnect(ws, registered, signal)) return;

    if (hasHandleConnection(registered.gatewayInstance)) {
      await registered.gatewayInstance.handleConnection(wrapSocket(ws, this.topics, this.wrapOptions(ws, signal)));
      throwIfAborted(signal);
      await this.sessionManager.flushSession(session.sid);
    }
  }

  private enqueueMessage(ws: ServerWebSocket<WsConnectionData>, raw: string | Buffer): void {
    if (this.closed || ws.data.closed || ws.data.messageProcessingStopped) {
      return;
    }
    const registered = this.resolveNamespace(ws);
    if (!registered || payloadBytes(raw) > registered.maxPayloadBytes) {
      this.closeConnection(ws, 1009, "payload too large");
      return;
    }
    const ingressKey = `ingress:${ws.data.connId}`;
    if (!this.ingressRateLimiter.check(
      ingressKey,
      this.limits.maxIngressPacketsPerWindow,
      this.limits.ingressWindowMs,
    )) {
      this.sendError(ws, "Too many messages");
      return;
    }

    let queue = this.messageQueues.get(ws.data.connId);
    if (!queue) {
      queue = { tail: this.openOperations.get(ws.data.connId) ?? Promise.resolve(), pending: 0 };
      this.messageQueues.set(ws.data.connId, queue);
    }
    if (queue.pending >= this.limits.maxPendingMessagesPerConnection) {
      this.sendError(ws, "Too many pending messages");
      this.closeConnection(ws, 1013, "message queue exceeded");
      return;
    }

    queue.pending += 1;
    const currentQueue = queue;
    const task = queue.tail.then(async () => {
      if (ws.data.closed || ws.data.messageProcessingStopped || this.closed) {
        return;
      }
      if (this.activeMessageHandlers >= this.limits.maxConcurrentMessageHandlers) {
        this.sendError(ws, "WebSocket service busy");
        return;
      }
      this.activeMessageHandlers += 1;
      const messageController = new AbortController();
      this.messageControllers.set(ws.data.connId, messageController);
      const work = this.observeWork(() => this.handleMessage(ws, raw, messageController.signal), () => {
        if (this.messageControllers.get(ws.data.connId) === messageController) {
          this.messageControllers.delete(ws.data.connId);
        }
        this.activeMessageHandlers -= 1;
      }, ws.data.connId);
      try {
        await runAbortable(
          () => work,
          messageController,
          this.limits.messageHandlingTimeoutMs,
          "WebSocket message processing timed out.",
        );
      } catch (error) {
        if (error instanceof WebSocketOperationTimeoutError) {
          ws.data.messageProcessingStopped = true;
          this.sendError(ws, "Message processing timed out");
          this.closeConnection(ws, 1011, "message processing timed out");
          return;
        }
        if (messageController.signal.aborted && (this.closed || ws.data.closed)) {
          return;
        }
        ws.data.messageProcessingStopped = true;
        this.sendError(ws, "Message processing failed");
        this.closeConnection(ws, 1011, "message processing failed");
      }
    }).finally(() => {
      currentQueue.pending = Math.max(0, currentQueue.pending - 1);
      if (currentQueue.pending === 0 && this.messageQueues.get(ws.data.connId) === currentQueue) {
        this.messageQueues.delete(ws.data.connId);
      }
    });
    currentQueue.tail = task;
    this.trackOperation(task);
  }

  private async handleMessage(
    ws: ServerWebSocket<WsConnectionData>,
    raw: string | Buffer,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const registered = this.resolveNamespace(ws);
    if (
      !registered
      || !ws.data.opened
      || this.connectionsBySid.get(ws.data.sid) !== ws
    ) {
      this.closeConnection(ws, 4009, "stale connection");
      return;
    }

    if (!this.sessionManager.touchSession(ws.data.sid, ws.data.connId)) {
      this.closeConnection(ws, 4009, "session lease expired");
      return;
    }
    await this.sessionManager.flushSession(ws.data.sid);
    throwIfAborted(signal);

    let packet: ClientPacket;
    try {
      packet = this.codec.decodeClient(raw);
    } catch (error) {
      this.sendError(ws, error instanceof PacketCodecError ? "Invalid packet" : "Packet decoding failed");
      return;
    }

    if (packet.id !== undefined && (typeof packet.id !== "string" || packet.id.length > this.limits.maxPacketIdLength)) {
      this.sendError(ws, "Packet id is too long");
      return;
    }
    if (packet.namespace !== undefined && packet.namespace !== registered.namespace) {
      this.sendError(ws, "Namespace mismatch", packet.id);
      return;
    }

    if (packet.type === "ping" || packet.type === "reconnect" || packet.type === "replay-ack") {
      const controlKey = `control:${ws.data.connId}`;
      if (!this.controlRateLimiter.check(
        controlKey,
        this.limits.maxControlFramesPerWindow,
        this.limits.controlFrameWindowMs,
      )) {
        this.sendError(ws, "Too many control frames", packet.id);
        return;
      }
    }

    if (packet.type === "ping") {
      this.encodeSend(ws, { type: "pong" });
      return;
    }
    if (packet.type === "reconnect") {
      await this.handleReconnectMessage(ws, packet, registered, signal);
      return;
    }
    if (packet.type === "replay-ack") {
      const ids = (packet.data as { deliveryIds?: unknown } | null)?.deliveryIds;
      if (ws.data.replayDelivery !== "client-ack" || !Array.isArray(ids)
        || ids.length === 0 || ids.length > this.limits.maxOutboundQueuePerSession
        || ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
          || !(ws.data.sentReplayIds?.has(id) || ws.data.sentReliableIds?.has(id) || ws.data.recentReliableAcks?.has(id)))) {
        this.sendError(ws, "Invalid replay acknowledgement", packet.id);
        return;
      }
      const reliableIds = ids.filter((id) => ws.data.sentReliableIds?.has(id) || ws.data.recentReliableAcks?.has(id));
      const remoteCount = reliableIds.length && this.adapter.reliableRooms
        ? await this.adapter.reliableRooms.acknowledge(this.deliveryOwner(ws), reliableIds) : 0;
      throwIfAborted(signal);
      const acknowledged = remoteCount + this.sessionManager.acknowledgeDeliveries(ws.data.sid, ids);
      await this.sessionManager.flushSession(ws.data.sid);
      throwIfAborted(signal);
      for (const id of reliableIds) {
        ws.data.sentReliableIds?.delete(id);
        (ws.data.recentReliableAcks ??= new Set()).add(id);
      }
      while ((ws.data.recentReliableAcks?.size ?? 0) > this.limits.maxOutboundQueuePerSession) {
        ws.data.recentReliableAcks!.delete(ws.data.recentReliableAcks!.values().next().value!);
      }
      this.diagnose("reliable-acked", acknowledged);
      this.queueDeliveries([ws.data.sid]);
      if (packet.id) this.encodeSend(ws, { type: "ack", id: packet.id, data: { acknowledged } });
      return;
    }
    if (
      packet.type !== "event"
      || typeof packet.event !== "string"
      || packet.event.length === 0
      || packet.event.length > this.limits.maxEventNameLength
    ) {
      this.sendError(ws, "Invalid event name", packet.id);
      return;
    }

    const handler = registered.handlers.get(packet.event);
    if (!handler) {
      this.sendError(ws, "Unknown event", packet.id);
      return;
    }

    const socket = wrapSocket(ws, this.topics, this.wrapOptions(ws, signal));
    if (handler.rateLimit) {
      let customKey: string | undefined;
      try {
        customKey = handler.rateLimit.key?.(socket);
      } catch {
        this.sendError(ws, "Rate limit policy failed", packet.id);
        return;
      }
      const key = customKey ?? `${socket.id}:${packet.event}`;
      if (customKey === undefined) {
        this.trackRateLimitKey(socket.id, key);
      }
      if (!this.handlerRateLimiter.check(key, handler.rateLimit.limit, handler.rateLimit.windowMs)) {
        this.sendError(ws, "Too many requests", packet.id);
        return;
      }
    }

    let reply: string | Uint8Array | undefined;
    try {
      await dispatchWsHandler(handler, socket, packet, (payload) => {
        if (signal.aborted || this.closed || ws.data.closed || ws.data.messageProcessingStopped) {
          return;
        }
        if (payloadBytes(payload) > outboundLimit(registered)) {
          this.closeForOutbound(ws, 1009, "outbound payload too large");
          return;
        }
        reply = payload;
      }, signal, this.codec);
      // Acknowledging join/context before persistence lets another node observe
      // the successful reply while the corresponding room membership is absent.
      await this.sessionManager.flushSession(ws.data.sid);
      throwIfAborted(signal);
      if (reply !== undefined && !trySendPayload(ws, reply)) this.closeForOutbound(ws, 1011, "outbound send failed");
    } catch (error) {
      throwIfAborted(signal);
      const rawMessage = error instanceof WsDispatchError && error.cause instanceof Error
        ? error.cause.message
        : error instanceof Error
          ? error.message
          : undefined;
      const safeMessage = error instanceof WsDispatchError ? error.message : "Handler failed";
      const cause = error instanceof WsDispatchError ? error.cause : error;
      if (cause instanceof WebSocketDeliveryError) this.sendError(ws, cause.message, packet.id, cause.code);
      else this.sendError(ws, this.options.exposeHandlerErrors === true && rawMessage ? rawMessage : safeMessage, packet.id);
    }
    throwIfAborted(signal);
  }

  private async handleCloseSafely(ws: ServerWebSocket<WsConnectionData>, reason: string): Promise<void> {
    try {
      await this.handleClose(ws, reason);
    } catch {
      // Close callbacks cannot report to the peer; shutdown still awaits all
      // remaining adapter/session operations.
    }
  }

  private async handleClose(ws: ServerWebSocket<WsConnectionData>, reason: string): Promise<void> {
    const closeTimer = this.closeTimers.get(ws.data.connId);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    this.closeTimers.delete(ws.data.connId);
    if (ws.data.closed) {
      return;
    }
    ws.data.closed = true;
    ws.data.lifetimeController.abort(
      new WebSocketOperationAbortedError("WebSocket connection closed."),
    );
    this.messageControllers.get(ws.data.connId)?.abort(
      new WebSocketOperationAbortedError("WebSocket connection closed."),
    );
    if (ws.data.opened) {
      this.activeConnections = Math.max(0, this.activeConnections - 1);
    }
    this.ingressRateLimiter.forget(`ingress:${ws.data.connId}`);
    this.controlRateLimiter.forget(`control:${ws.data.connId}`);
    this.messageQueues.delete(ws.data.connId);

    const ownsSession = this.connectionsBySid.get(ws.data.sid) === ws;
    if (ownsSession) {
      this.connectionsBySid.delete(ws.data.sid);
      await this.sessionManager.releaseActiveConnection(ws.data.sid, ws.data.connId, ws.data.rooms);
      this.forgetRateLimitKeys(ws.data.sid);
    }

    for (const room of ws.data.rooms) {
      this.topics.delete(ws.data.namespace, room);
    }
    const registered = this.resolveNamespace(ws);
    await this.connectionWork.get(ws.data.connId);
    if (registered && ws.data.opened && hasHandleDisconnect(registered.gatewayInstance)) {
      await registered.gatewayInstance.handleDisconnect(
        wrapSocket(ws, this.topics, this.wrapOptions(ws)),
        reason,
      );
    }
  }

  private trackRateLimitKey(sid: string, key: string): void {
    let keys = this.rateLimitKeysBySid.get(sid);
    if (!keys) {
      keys = new Set<string>();
      this.rateLimitKeysBySid.set(sid, keys);
    }
    keys.add(key);
  }

  private forgetRateLimitKeys(sid: string): void {
    const keys = this.rateLimitKeysBySid.get(sid);
    if (!keys) {
      return;
    }
    this.handlerRateLimiter.forgetMany(keys);
    this.rateLimitKeysBySid.delete(sid);
  }

  private trackOperation(operation: Promise<void>): void {
    const guarded = operation.catch(() => {});
    const pending = this.pendingOperations;
    pending.add(guarded);
    void guarded.finally(() => pending.delete(guarded));
  }

  /** Tracks actual settlement separately from the caller's abortable wait. */
  private observeWork<T>(operation: () => Promise<T>, onSettled?: () => void, connId?: string): Promise<T> {
    const work = Promise.resolve().then(operation);
    const release = (): void => {
      this.pendingWork.delete(completion);
      if (connId !== undefined && this.connectionWork.get(connId) === completion) this.connectionWork.delete(connId);
      onSettled?.();
    };
    const completion = work.then(release, release);
    this.pendingWork.add(completion);
    if (connId !== undefined) this.connectionWork.set(connId, completion);
    return work;
  }

  private trackAdapterOperation(operation: Promise<void>): void {
    const guarded = operation.catch((error: unknown) => {
      this.diagnose("adapter-error");
      this.adapterOperationError ??= error;
    });
    const pending = this.pendingAdapterOperations;
    pending.add(guarded);
    void guarded.finally(() => pending.delete(guarded));
  }

  public async getHealth(): Promise<{ ready: boolean; reason?: "stopped" | "store" }> {
    if (!this.initialized || this.closed) return { ready: false, reason: "stopped" };
    try { await this.adapter.healthCheck?.(); return { ready: true }; }
    catch { this.diagnose("adapter-error"); return { ready: false, reason: "store" }; }
  }

  private diagnose(type: WebSocketDiagnostic["type"], count = 1): void {
    this.deliveryCounters[type] += count;
    try { this.options.onDiagnostic?.({ type, count, timestamp: Date.now() }); }
    catch { /* Observers cannot alter delivery or resource ownership. */ }
  }

  private deliveryOwner(ws: ServerWebSocket<WsConnectionData>): ReliableSessionOwner {
    return { sid: ws.data.sid, connId: ws.data.connId, ownerInstanceId: this.adapter.instanceId,
      ...(ws.data.sentReliableIds ? { issuedIds: [...ws.data.sentReliableIds] } : {}) };
  }

  private queueDeliveries(sids: Iterable<string>): void {
    if (this.closed || !this.adapter.reliableRooms) return;
    for (const sid of sids) if (this.connectionsBySid.has(sid)) this.deliveryCandidates.add(sid);
    if (this.deliveryInFlight || !this.deliveryCandidates.size) return;
    this.deliveryInFlight = true;
    this.trackOperation(this.deliverCandidates().catch(() => {
      this.deliveryCandidates.clear();
      this.diagnose("poll-error");
    }).finally(() => { this.deliveryInFlight = false; }));
  }

  private async deliverCandidates(): Promise<void> {
    while (!this.closed && this.deliveryCandidates.size) {
      const sockets: ServerWebSocket<WsConnectionData>[] = [];
      for (const sid of this.deliveryCandidates) {
        this.deliveryCandidates.delete(sid);
        const ws = this.connectionsBySid.get(sid);
        if (ws && ws.data.opened && !ws.data.closed && !ws.data.messageProcessingStopped
          && !ws.data.replaying && !this.openOperations.has(ws.data.connId) && ws.data.replayDelivery === "client-ack") sockets.push(ws);
        if (sockets.length >= 128) break;
      }
      if (!sockets.length) continue;
      const owners = sockets.map((ws) => this.deliveryOwner(ws));
      const batches = await this.adapter.reliableRooms!.readPending(owners);
      for (const batch of batches) {
        // Empty mailboxes need no local session lookup: getSession also sweeps
        // expiry. Calling it for every idle owner makes each poll quadratic.
        if (!batch.packets.length) continue;
        const index = owners.findIndex((owner) => owner.sid === batch.sid);
        const ws = sockets[index];
        if (!ws || this.closed || ws.data.closed || ws.data.messageProcessingStopped || ws.data.replaying
          || ws.data.sid !== batch.sid || this.connectionsBySid.get(batch.sid) !== ws) continue;
        const state = this.sessionManager.getSession(batch.sid);
        if (!state || state.activeConnId !== ws.data.connId || (state.activeLeaseExpiresAt ?? 0) <= Date.now()) continue;
        const issued = ws.data.sentReliableIds ??= new Set();
        for (const packet of batch.packets) {
          if (!packet.deliveryId || issued.has(packet.deliveryId) || ws.data.recentReliableAcks?.has(packet.deliveryId)) continue;
          if (issued.size >= this.limits.maxOutboundQueuePerSession || (ws.getBufferedAmount?.() ?? 0) > 0) break;
          if (!this.encodeSend(ws, packet)) break;
          issued.add(packet.deliveryId);
        }
      }
    }
  }

  private async awaitPendingOperations(): Promise<void> {
    while (this.pendingOperations.size > 0) {
      await Promise.all([...this.pendingOperations]);
    }
  }

  private async awaitPendingAdapterOperations(): Promise<void> {
    while (this.pendingAdapterOperations.size > 0) {
      await Promise.all([...this.pendingAdapterOperations]);
    }
  }

  private async shutdownInitializedGateways(): Promise<void> {
    const gateways = this.initializedGateways.splice(0).reverse();
    const errors: unknown[] = [];
    for (const gateway of gateways) {
      if (hasOnGatewayShutdown(gateway)) {
        try {
          await gateway.onGatewayShutdown();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private abortMessageOperations(message: string): void {
    for (const controller of this.messageControllers.values()) {
      controller.abort(new WebSocketOperationAbortedError(message));
    }
  }


}

export type { WsConnectionData };

function validateAuthenticatedOrigins(options: WebSocketServerOptions): void {
  if (options.requireAuth === true && !options.authenticator) {
    throw new Error("WebSocket requireAuth requires an authenticator.");
  }
  if (!options.authenticator) {
    return;
  }
  for (const namespace of options.namespaces) {
    const origins = namespace.corsOrigins.length > 0
      ? namespace.corsOrigins
      : (options.defaultCorsOrigins ?? ["*"]);
    if (origins.length === 0 || origins.includes("*")) {
      throw new Error(
        `WebSocket namespace "${namespace.namespace}" uses authentication and requires explicit CORS origins.`,
      );
    }
  }
}

function outboundLimit(namespace: RegisteredNamespace): number {
  return namespace.maxOutboundPayloadBytes ?? namespace.maxPayloadBytes;
}

function validateNamespace(namespace: RegisteredNamespace): void {
  if (!Number.isFinite(outboundLimit(namespace)) || outboundLimit(namespace) <= 0) {
    throw new Error(`WebSocket namespace "${namespace.namespace}" requires a positive maxOutboundPayloadBytes.`);
  }
  if (!namespace.namespace.startsWith("/") || namespace.namespace.includes("\0")) {
    throw new Error(`Invalid WebSocket namespace "${namespace.namespace}".`);
  }
  if (!namespace.path.startsWith("/") || namespace.path.includes("\0") || namespace.path.includes("?") || namespace.path.includes("#")) {
    throw new Error(`Invalid WebSocket path "${namespace.path}".`);
  }
  if (!Number.isFinite(namespace.maxPayloadBytes) || namespace.maxPayloadBytes <= 0) {
    throw new Error(`WebSocket namespace "${namespace.namespace}" requires a positive maxPayloadBytes.`);
  }
  if (!Number.isFinite(namespace.sessionTtlMs) || namespace.sessionTtlMs <= 0) {
    throw new Error(`WebSocket namespace "${namespace.namespace}" requires a positive sessionTtlMs.`);
  }
}

function normalizeMemoryLimits(limits: WebSocketMemoryLimits | undefined): Required<WebSocketMemoryLimits> {
  return {
    maxRateLimitBuckets: positiveLimit(limits?.maxRateLimitBuckets, 10_000, "maxRateLimitBuckets"),
    maxTopics: positiveLimit(limits?.maxTopics, 10_000, "maxTopics"),
    maxSessions: positiveLimit(limits?.maxSessions, 10_000, "maxSessions"),
    maxRoomsPerSession: positiveLimit(limits?.maxRoomsPerSession, 256, "maxRoomsPerSession"),
    maxRoomNameLength: positiveLimit(limits?.maxRoomNameLength, 256, "maxRoomNameLength"),
    maxOutboundQueuePerSession: positiveLimit(limits?.maxOutboundQueuePerSession, 100, "maxOutboundQueuePerSession"),
    maxOutboundQueueBytesPerSession: positiveLimit(
      limits?.maxOutboundQueueBytesPerSession,
      1024 * 1024,
      "maxOutboundQueueBytesPerSession",
    ),
    maxOfflineBroadcastRecipients: positiveLimit(
      limits?.maxOfflineBroadcastRecipients,
      1_000,
      "maxOfflineBroadcastRecipients",
    ),
    maxOfflineBroadcastBytes: positiveLimit(
      limits?.maxOfflineBroadcastBytes,
      1024 * 1024,
      "maxOfflineBroadcastBytes",
    ),
    maxConcurrentHandshakes: positiveLimit(limits?.maxConcurrentHandshakes, 64, "maxConcurrentHandshakes"),
    handshakeTimeoutMs: nonNegativeLimit(limits?.handshakeTimeoutMs, 10_000, "handshakeTimeoutMs"),
    maxHandshakeAttemptsPerWindow: positiveLimit(
      limits?.maxHandshakeAttemptsPerWindow,
      60,
      "maxHandshakeAttemptsPerWindow",
    ),
    handshakeWindowMs: positiveLimit(limits?.handshakeWindowMs, 60_000, "handshakeWindowMs"),
    maxIngressPacketsPerWindow: positiveLimit(
      limits?.maxIngressPacketsPerWindow,
      120,
      "maxIngressPacketsPerWindow",
    ),
    ingressWindowMs: positiveLimit(limits?.ingressWindowMs, 10_000, "ingressWindowMs"),
    maxControlFramesPerWindow: positiveLimit(
      limits?.maxControlFramesPerWindow,
      30,
      "maxControlFramesPerWindow",
    ),
    controlFrameWindowMs: positiveLimit(limits?.controlFrameWindowMs, 10_000, "controlFrameWindowMs"),
    maxPendingMessagesPerConnection: positiveLimit(
      limits?.maxPendingMessagesPerConnection,
      32,
      "maxPendingMessagesPerConnection",
    ),
    maxConcurrentMessageHandlers: positiveLimit(
      limits?.maxConcurrentMessageHandlers,
      256,
      "maxConcurrentMessageHandlers",
    ),
    messageHandlingTimeoutMs: nonNegativeLimit(
      limits?.messageHandlingTimeoutMs,
      30_000,
      "messageHandlingTimeoutMs",
    ),
    shutdownDrainTimeoutMs: nonNegativeLimit(
      limits?.shutdownDrainTimeoutMs,
      5_000,
      "shutdownDrainTimeoutMs",
    ),
    activeSessionLeaseMs: positiveLimit(limits?.activeSessionLeaseMs, 30_000, "activeSessionLeaseMs"),
    leaseRenewIntervalMs: positiveLimit(limits?.leaseRenewIntervalMs, 10_000, "leaseRenewIntervalMs"),
    maxSessionIdLength: positiveLimit(limits?.maxSessionIdLength, 128, "maxSessionIdLength"),
    maxEventNameLength: positiveLimit(limits?.maxEventNameLength, 128, "maxEventNameLength"),
    maxPacketIdLength: positiveLimit(limits?.maxPacketIdLength, 128, "maxPacketIdLength"),
    maxBackpressureBytes: positiveLimit(limits?.maxBackpressureBytes, 1024 * 1024, "maxBackpressureBytes"),
    socketCloseTimeoutMs: positiveLimit(limits?.socketCloseTimeoutMs, 1000, "socketCloseTimeoutMs"),
    reliablePollIntervalMs: positiveLimit(limits?.reliablePollIntervalMs, 1000, "reliablePollIntervalMs"),
  };
}

function positiveLimit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`WebSocket limit "${field}" must be a positive number.`);
  }
  return Math.floor(value);
}

function cloneSocketUser(user: SocketUser): SocketUser {
  return { ...user };
}

function nonNegativeLimit(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`WebSocket limit "${field}" must be a non-negative number.`);
  }
  return value === 0 ? 0 : Math.max(1, Math.floor(value));
}

function payloadBytes(payload: string | Uint8Array | Buffer): number {
  return typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
}

function requestAddress(server: Server<WsConnectionData>, request: Request): string {
  try {
    return server.requestIP(request)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

class WebSocketOperationTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebSocketOperationTimeoutError";
  }
}

class WebSocketOperationAbortedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WebSocketOperationAbortedError";
  }
}

/**
 * Observes the underlying promise even after the deadline wins. This prevents
 * late middleware/validator/handler rejection from becoming unhandled while
 * keeping the caller's wait bounded. The owner separately tracks actual work
 * settlement for admission and resource cleanup.
 */
function runAbortable<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const observed = Promise.resolve().then(operation);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      controller.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      const reason = controller.signal.reason;
      finish(() => reject(reason instanceof Error ? reason : new WebSocketOperationAbortedError("Operation aborted.")));
    };

    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) {
      onAbort();
    }
    if (timeoutMs > 0 && !settled) {
      timer = setTimeout(() => {
        const error = new WebSocketOperationTimeoutError(timeoutMessage);
        controller.abort(error);
      }, timeoutMs);
    }
    observed.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Returns false on deadline without abandoning rejection observation. */
async function settleBeforeDeadline(operation: () => Promise<void>, deadline: number | null): Promise<boolean> {
  const observed = Promise.resolve().then(operation);
  if (deadline === null) {
    await observed;
    return true;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void observed.catch(() => {});
    return false;
  }
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, remaining);
    observed.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new WebSocketOperationAbortedError("Operation aborted.");
}
