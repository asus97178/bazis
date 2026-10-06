# WebSocket

Passport version: 1.4. Date: 2026-10-04. Status: cross-node delivery is implemented; the qualification is in the report below.
Type: atomic technical module. Path: `src/bazis/core/websocket`.
Connection: [websocketModule(config)](websocketModule.ts).
Passport scope: audit fixes, replay and reliable cross-node delivery. The full existing
configuration fields are in the source contracts.

## Cross-node delivery contract

The existing atomic technical module is kept. The components live inside it; no CLI
scaffold of a new module is needed. The Redis adapter uses a separate delivery store and
a limiter of native operations; WebSocketServer delivers from the shared store and
provides diagnostics and readiness. ORM, DI ports and ownership of the host RedisClient
are kept. The queue state is separate from the session revision, so a publication on
another node does not conflict with the owner's lease/ACK.

| New input | Contract / default | Checks and effect |
| --- | --- | --- |
| `socket.to(room).emitReliable(event, data, options)` | A Promise receipt; room and event are required, data is JSON-compatible or undefined | The gateway decides access, namespace/excludeSid come from the server. Needs the adapter capability and client-ack at the recipients |
| `options.messageId` | A required UUID v4, null is forbidden | One ID per logical publication; unchanged when retried after an undetermined result |
| `options.expiresAt` | Required Unix ms, a safe integer | The deadline for accepting the operation, at most 60 seconds ahead by the store clock; a retry keeps the original value |
| Receipt | messageId, recipients, duplicate | Success means a write to all recorded recipients, not a client ACK; the queue is kept until ACK/session TTL |
| `adapter.reliableRooms` | An optional capability | Atomic global room fan-out, bounded reads and ACK with an owner/connId check; older adapters keep the legacy mode |
| `onDiagnostic` | An optional sync callback, without payloads/secrets | Failure/overflow/conflict events and counters; an observer exception is isolated |
| `limits.reliablePollIntervalMs` | Positive ms; 1000 | Polling complements pub/sub; batch reads are bounded by the number of sessions and bytes |
| Redis `operationTimeoutMs`, `maxPendingOperations` | Positive integers; 2000 ms, 64 | A timeout is not presented as cancelling native I/O; unfinished operations keep holding bounded slots |
| Redis `deliveryClient` | An optional host-owned Bun RedisClient; the default is the shared command client | Separates the delivery command connections from session I/O. Initialize checks the shared logical store with a nonce probe before writing the policy. Both clients belong to the host; the shared native admission limit is kept. A separate client alone does not guarantee throughput |
| Redis reliable limits | maxQueueMessages=100, maxQueueBytes=1MiB, maxRecipients=1000, maxFanoutBytes=8MiB, maxOperations=10000, maxReadBytes=1MiB | Hard bounds, rejection instead of evicting unacknowledged data; one policy for the nodes of one prefix |
| Redis `reliable.requireAof` | boolean; true, null is forbidden | At startup/readiness checks appendonly=yes, appendfsync=always, no-appendfsync-on-rewrite=no, noeviction and the AOF status. false removes the durability check; surviving a storage crash is not guaranteed in that mode |

The existing emit stays a transport API, but rejection by the offline queue becomes an
explicit error and a diagnostic event. For the new reliable operation, admission errors
are checked before fan-out; a transport timeout means an undetermined result, and a
retry is safe only with the original messageId/expiresAt.
One Redis primary/replication group is the atomic boundary. Redis Cluster with keys
spread across shards is outside this contract. Checks: cross-node offline, a lost
notification, a Valkey failure/restart with AOF, a network split, a rolling replacement,
a binary run and a measured load profile. The actual PASS/FAIL and limits are in the
qualification report.

## 1. Responsibility and components

MOD-ARCH-001 §2.1 priorities: one technical feature, the existing DI/ports; separate
classes for delivery and native I/O have their own duties inside the atomic module.
Heartbeat and mass shutdown use up to 16 parallel operations; mailboxes are read in
batches of up to 128 owners with a response byte limit. The executed binary uses the
same public runtime. Empty READ results are skipped before the local session lookup:
idle polling does not run a full expiry sweep for every empty mailbox. For a non-empty
result the checks of the current connId, lease and backpressure are kept.
Trade-off: a synchronous AOF write increases latency for the sake of keeping the
accepted queue; Lua is needed for atomic fan-out without a new ORM or broker.

The module owns WebSocket on the shared HTTP listener: upgrade, gateways, packets,
rooms, sessions, replay and lifecycle. It uses the existing DI, the HTTP port and the
adapter interface. Application authorization and storage operations belong to the
application. No new modules, ORM, migrations or second database pool are created.
The Redis adapter is an extra implementation of the existing port.

| Component | Responsibility |
| --- | --- |
| [WebSocketServer](ws-server.ts) | Deadlines, replay negotiation, ACK and ownership, native drain, bounded close |
| [SessionManager](session-manager.ts) | The local session/room index, a bounded queue, delivery IDs, ordered writes with CAS |
| [Dispatcher](ws-dispatch.ts) | One handler response with the chosen codec, deferred ACK and cancellation |
| [Socket wrapper](socket-wrapper.ts) | The public BazisSocket, the send result, the physical connection state |
| [In-memory adapter](adapter/in-memory.adapter.ts) | Separate limits for live sessions and deletion history, protection from old snapshots |
| [Creation token](session-creation.ts) | The internal process-local creation order for history compaction |
| [Redis adapter](adapter/redis.adapter.ts) | Cross-node live pub/sub and atomic session storage on the existing Bun RedisClient |
| [Reliable delivery store](adapter/redis-delivery-store.ts) | The port of global mailboxes, idempotency, the durability policy, the canonical hash from the existing library/boundary |
| [Redis operations](adapter/redis-operations.ts) | Bounds native I/O and waiting; a timed-out operation keeps holding its slot until it actually finishes |
| [Lua scripts](adapter/redis-delivery-scripts.ts) | Atomic updates of membership, admission, mailbox and ACK |
| [Types](types.ts), [codecs](codec/packet-codec.interface.ts) | An additive extension of wire v1; the same semantics for JSON and binary |

## 2. DI and public boundaries

The factory registers gateways as singletons; the existing codegen wires the constructor
dependencies. The singleton resolver factory `WEBSOCKET_UPGRADE` collects them through
WebSocketExplorer. `WebSocketModule` is global and explicitly exports
`[WEBSOCKET_UPGRADE]`. The dependency direction is WebSocket → HTTP; HTTP calls the
upgrade port. TypeScript entry: [index.ts](index.ts), `bazis/core/websocket`.
New TypeScript exports: `ReplayDelivery`, `ReplayAcknowledgement`,
`RedisWebSocketAdapter` and its options, `ReliableBroadcastOptions/Receipt`,
`ReliableRoomDelivery/Publication`, `ReliableSessionOwner/DeliveryBatch`,
`WebSocketDeliveryError`, `WebSocketDiagnostic`, `RedisReliableDeliveryOptions`.
There are no new DI exports.

The runtime or the consumer constructs the adapter by hand. WebSocket is in the
generator's `FRAMEWORK_INTERNAL_PREFIXES`. Gateway registrations and dependencies did not
change; codegen is not needed, and generated files are not affected by this fix.
The published inputs are the existing upgrade routes and WebSocket packets; there are
no new HTTP/AI endpoints.

## 3. Input contracts

The fields below are optional unless stated otherwise; null is not supported.

| Input | Type, default | Check and behavior |
| --- | --- | --- |
| Config `replayDelivery` / query `replay` | `transport` or `client-ack`; default `transport` | An unknown/repeated query is HTTP 400. Config `client-ack` requires this mode; a downgrade is 409 |
| `ClientPacket.type` | Required: `event`, `ping`, `reconnect`, the new `replay-ack` | Wire v1, namespace, payload, correlation id and ingress/control rate limits are kept |
| `replay-ack.data.deliveryIds` | A required non-empty `string[]` | At most `maxOutboundQueuePerSession`, UUID v4, each ID issued to this physical connection; otherwise an error without changing the queue |
| `replay-ack.id` | An optional correlation string | After the ACK is saved: `{type:"ack", id, data:{acknowledged:number}}`; repeating a recently accepted ID on the same connection gives 0; the remote ACK history is bounded by maxOutboundQueuePerSession |
| `ServerPacket.deliveryId` | The UUID of a queued packet | A stable client-ack replay ID, separate from the correlation id |
| `connected/reconnected.replayDelivery` | `client-ack` in the negotiated mode | The client checks the mode before acknowledging |
| `reconnected.replayCount` | The number of packets in the current replay batch | Includes missed and the following frames of this batch; the remaining global mailbox packets are delivered by polling |
| `SessionState.creationToken` | An optional immutable string | The runtime issues a process incarnation + a monotonic number; the legacy boundary is described below |
| `SessionState.replayDelivery` | An optional mode; legacy `transport` | A saved client-ack cannot be downgraded by the next reconnect |
| `limits.maxBackpressureBytes` | Positive number of bytes; 1 MiB | The native outgoing buffer; replay waits for drain, overflow closes the recipient |
| `limits.socketCloseTimeoutMs` | Positive number of ms; 1000 | After a runtime close, forcibly ends the socket if the peer did not finish the close handshake |
| `limits.handshakeTimeoutMs` | Non-negative ms; 10000 | A shared upgrade deadline with I/O; a separate open/replay deadline; 0 disables |
| `limits.messageHandlingTimeoutMs` | Non-negative ms; 30000 | Includes validation and the deferred callback; 0 disables |
| `codec` | PacketCodec; JSON | One codec for ACK, emit, replay and broadcast; binary framing is kept |

SessionManager additions: a fifth optional `replayDelivery` argument of `createSession`;
`enableReplayAcknowledgements(sid): void`; `acknowledgeDeliveries(sid, deliveryIds): number`.
These are internal transport operations. The server checks access to the SID,
namespace, principal and owner.

Migrating a legacy queue assigns IDs after the claim; if they exceed the byte limit,
the transition is rejected without losing the queue. `acknowledgeDeliveries` removes
only the named IDs; checking that they were issued beforehand is mandatory.
`peekOutbound` does not change the queue. `acknowledgeOutbound(sid, count)` removes only
the transport prefix, with no await between send and removal; count=0 changes nothing.
An invalid count and a positive count for client-ack throw an Error.
`drainOutbound` cannot remove an unacknowledged client-ack queue either.

## 4. Replay, queue and lifecycle

Incoming messages wait for open and `handleConnection`. Cancellation stops waiting and
suppresses late effects, but does not roll back I/O already started by an arbitrary
adapter. State change responses are sent after `flushSession`.
Physical connection activity is merged into periodic saves: at most one write per
third of the smaller of the session TTL and the active lease. Between them only the
local lastSeenAt is updated; expiresAt/activeLeaseExpiresAt are not extended without a
write. An expired lease still rejects a frame. Room changes, an explicit
SessionManager.updateContext, queues and ownership are saved through the same CAS.
This introduces no automatic saving of arbitrary socket.data mutations.
Background renewal is spread by a deterministic SID offset within the safe TTL/lease
window. The runtime checks due sessions in short ticks instead of saving all sessions
in one wave. The limit of 16 native workers and the CAS order of each SID are kept.
An internal optional schedule of renewOwnedLeases sets non-negative safe integers
afterMs/spreadMs; a call without a schedule keeps the former immediate renewal.

Replay accounts for the actual size of the encoded frame: the prefix that fits goes into
`reconnected.missed`, the remaining packets follow in order as separate frames.
On backpressure the server waits for drain and continues on the next event-loop turn
after the native callback. A deadline bounds the wait; the runtime close handshake is
bounded by `socketCloseTimeoutMs`.

- `transport` keeps compatibility: the prefix accepted by the transport is removed.
  This is not proof that the client received it.
- `client-ack` keeps the whole replay until the client acknowledges it. A break
  without ACK repeats the same IDs; a partial ACK allows any order. The client
  acknowledges after processing and deduplicates by deliveryId. ACK groups are bounded
  by the payload and the control rate limit. Example: [DESIGN.md](DESIGN.md).

A reliable queue rejects new packets at the count/byte limit and keeps the old ones.
`enqueueOutbound` returns false. The internal offline fan-out returns `truncated`;
the runtime uses its strict allOrNothing mode and raises `OFFLINE_QUEUE_CAPACITY`
before the live publication. The former optional SessionManager mode and transport
enqueue keep compatibility with eviction.
A rejection is no longer lost behind a successful handler response.
Regular saves use CAS when the operation is available. A conflict makes the flush fail
and removes the stale local index, keeping the new owner.
Client-ack needs an adapter with CAS, otherwise HTTP 503.

The guarantee is limited to the messages accepted into the queue, the session TTL and
the storage. Surviving a process crash applies to an already saved queue:
`enqueueOutbound=true` before `flushSession` finishes does not prove a write yet.
A live emit/broadcast alone does not get this guarantee. Exactly-once of an external
side effect is not promised. Application deduplication belongs to the application.

A handler ACK differs from a replay ACK: a third handler argument and an undefined
result mean deferred until the callback/cancellation. A non-empty return or no third
argument gives an automatic ACK. Together the callback and return produce at most one
response; without packet.id the dispatcher does not wait for the callback.

## 5. Adapters and data

### In-memory

Single-node, no persistence across restarts. Options are positive integers:

| Option | Default | Purpose |
| --- | --- | --- |
| `maxEntries` | 10000; the runtime passes maxSessions | Live records only |
| `maxTombstones` | maxEntries | An independent limit of the deletion history |
| `tombstoneTtlMs` | 60000 ms | The legacy initial-write window and the marker retention time |

A SID is never reused; createdAt and creationToken are immutable. A deleted SID is not
restored even by a snapshot with a higher revision. Old markers fold into a generation
boundary without taking live capacity; new runtime sessions get a higher number,
including those created in the same millisecond. Updates of existing records are
allowed regardless of this boundary. Close also keeps the boundary against late writes
after cleanup.

Compaction is conservative: a delayed first write created before the boundary may be
rejected. Legacy/imported snapshots without a local token use the createdAt boundary and
the initial-write window; telling such sessions apart within one millisecond is not
promised. The runtime does not import them as new SIDs.
Filling the live capacity gives SessionCapacityError and close 1013; the history is
bounded separately and does not block new generations.

### Redis / Valkey

`new RedisWebSocketAdapter(client, options)` uses the native Bun RedisClient of the
existing infrastructure. The host creates/configures and closes the command client and
the optional deliveryClient. The adapter owns only the duplicate for pub/sub; close
unsubscribes and closes the duplicate, does not clear keys and does not close either
host client. A separate deliveryClient must address the same logical DB; initialize
checks this with a temporary connection-check key with a nonce and a TTL.

| Option | Default | Limit |
| --- | --- | --- |
| `keyPrefix` | bazis:ws | 1–64 ASCII letters/digits/`:_-`; shared by the nodes of one application, separate for others |
| `writeProtectionMs` | 60000 ms | A positive safe integer; protection of the first write/deletion |
| `maxSessionBytes` | 8 MiB | A positive safe integer; a serialized session |
| `maxPublishBytes` | 1 MiB | A positive safe integer; a pub/sub packet |

One key per SID; revision/CAS and the write are atomic in one Lua command. The first
write requires revision 1 and an acceptable createdAt by the Redis clock. A record
lives until the later of expiresAt and the end of the creation window; deletion is
protected until the end of that window. Session JSON is stored as an opaque string,
keeping arrays/null. After the lease expires a new owner is allowed; CAS blocks the old
writer. Pub/Sub excludes a duplicate on the sender's node; the local fan-out uses the
receiving runtime's codec.

`emitReliable` uses a shared room → SID index and a separate LIST queue per SID.
A CAS session save atomically updates the membership and the queue TTL; publishing/ACK
of the queue does not change the session revision. Recipients include live and offline
sessions of any node in this prefix/namespace. Deleting a session deletes its mailbox;
the session TTL expiry ends the storage guarantee.

The Lua publication checks all capacity conditions before adding packets; the receipt
records the number of recipients. An operation with the same ID/deadline/data is
repeated without a second fan-out; a mismatch gives MESSAGE_ID_CONFLICT. The order of
JSON fields does not change the fingerprint. The existing canonicalJsonHashV1 and its
JSON structure limits are used. The operation history is bounded by maxOperations and
the acceptance deadline. Pub/Sub only speeds up delivery; polling picks it up when a
notification is lost. Unacknowledged IDs issued to this connection are excluded from
the next reads so they do not take the response budget of other recipients. READ/ACK
check the owner, connId and the active lease; after a reconnect the same IDs are issued again.

At startup and readiness the strict mode requires AOF always/noeviction,
no-appendfsync-on-rewrite=no (fsync is not skipped during compaction) and a healthy
write status. All nodes of a prefix must have one delivery policy. The host RedisClient
must allow CONFIG GET and INFO persistence, but the application does not need CONFIG SET.
Changing the policy needs a separate prefix or a managed migration after drain; do not
delete the policy while sessions exist. An old Redis without AOF no longer passes the
strict initialize: an explicit reliable.requireAof=false removes the durability check,
and surviving a storage crash is not guaranteed in that mode.
The full list of keys, ACL, errors and the operating procedure are in the report's runbook.

## 6. Checks and the readiness boundary

Current commands, PASS/FAIL, the load profile, hashes and operational limits:
[enterprise WebSocket qualification](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-websocket-enterprise/REPORT.md).
The checks use the pinned Bun 1.4.0; the toolchain did not change. Production and the
application database were not changed. There are no deviations from
[MOD-ARCH-001](../../../../docs/architecture/MODULE_ARCHITECTURE.md).

Historical checks: [replay reliability](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-websocket-reliability/REPORT.md)
and [seven audit fixes](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/2026-09-14-websocket-fixes/REPORT.md).
They do not replace the qualification of the current state of the files.

## Application authorization through DI and a separate output limit (2026-09-20)

Additive inputs of the existing module:

| Input | Default / check | Behavior |
| --- | --- | --- |
| config.middlewareFactory | absent; the function must return a WsMiddleware | The current kernel's resolver binds the upgrade policy to DI; the middleware runs after the standard origin/auth and before the gateway middleware |
| Gateway.maxOutboundPayloadBytes | maxPayloadBytes; a positive finite number | A separate limit for ACK, emit, broadcast and replay; incoming frames and native ingress are still bounded by maxPayloadBytes |

This does not cancel requireAuth/CORS and does not change the existing defaults. The
cookie policy, the Origin check, session revocation and scopes belong to the
application. A middlewareFactory implementation must not keep scoped services in a
singleton. Without the factory the former composition is identical. An invalid factory
result is rejected before the listener starts.
Checks: `test/ws.chat-transport.test.ts`, the existing unit/e2e tests; a real build of
AgentChat into a binary and a call through the shared HTTP/WebSocket listener.

## Accounting of unfinished work and shutdown (2026-10-04)

R6 of the repeated audit is fixed in the existing WebSocketServer. Public signatures,
DI and settings did not change. `maxConcurrentHandshakes` bounds the actually
unfinished upgrade operations, including the authenticator, middleware and session I/O.
`maxConcurrentMessageHandlers` likewise bounds message validation and handlers.
A timeout quickly returns HTTP 504 or closes the connection, but the slot is returned
only after the original operation finishes, including a late error. Until then new
operations get the existing busy rejection. There is no queue build-up around the
limit. The upgrade limit does not cover `handleConnection` after the upgrade; its
lifecycle is tracked separately.

`close()` returns one shared operation for all calls. It forbids new requests, signals
cancellation and forcibly closes the physical connections. `handleDisconnect` waits for
the current work of its connection. The gateway and the adapter are closed after the
callbacks and saves actually finish. If `shutdownDrainTimeoutMs` has expired, close
rejects with a timeout error; a repeated call keeps this result. The ordered cleanup
keeps waiting for the original operations and then releases the resources exactly once.
With 0 the shared deadline is disabled. A failure of each cleanup stage is observed;
gateway errors do not cancel the later adapter close.

Trade-off: permanently hung user code holds its slot and resources until the process
ends; a fast timeout is not presented as a physical cancellation. On shutdown the
calling host must handle the close error and must not declare the application effects
finished successfully. The HTTP owner already catches it, closes the listener and
returns its shutdown error. Rolling back external actions and forcibly ending an
arbitrary Promise are not promised.

Regressions: [ws.unit.test.ts](test/ws.unit.test.ts) checks held slots after a timeout,
late success/error, no late ACKs, the handler → disconnect → gateway → adapter order and
a repeated close. [ws.audit-regressions.test.ts](test/ws.audit-regressions.test.ts)
checks the same limit for an unfinished session load. These checks use a stub
transport. [ws.e2e.test.ts](test/ws.e2e.test.ts) additionally checks a real loopback
HTTP/WebSocket: a shutdown error by deadline, rejection of a new TCP connection to the
closed listener and the gateway finishing after the handler.
Redis and load qualification are not confirmed by this change.
There are no new dependencies, resources or dynamic imports; the checks of the built
regression fixture are described in the
[fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-reaudit-2026-10-04/FIXES.md).
