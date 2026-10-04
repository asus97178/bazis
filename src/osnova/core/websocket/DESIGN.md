# WebSocket Module

Status: implemented, single-node by default; optional client-confirmed replay
and Redis/Valkey adapter. See [MODULE.md](MODULE.md) for the verified scope.

WebSocket in Osnova shares the HTTP listener and uses native Bun WebSocket. The
public API is intentionally close to controllers: gateways are classes, message
handlers are methods, DI creates gateway instances, and the module registers an
upgrade port for `HttpServer`.

## Minimal Gateway

```ts
import { SubscribeMessage, WebSocketGateway, type OsnovaSocket } from "@/core/websocket";

@WebSocketGateway({ namespace: "chat" })
export class ChatGateway {
  @SubscribeMessage("echo")
  echo(_socket: OsnovaSocket, body: unknown) {
    return { echoed: body };
  }
}
```

Register it next to HTTP:

```ts
import { Module } from "@/core/di";
import { httpModule } from "@/core/http";
import { websocketModule } from "@/core/websocket";

@Module({
  imports: [
    httpModule({ port: 3000 }),
    websocketModule({ gateways: [ChatGateway] }),
  ],
})
export class AppModule {}
```

The gateway above upgrades on `/ws/chat`.

## Handler Convention

`@SubscribeMessage(event)` uses positional convention:

```ts
handler(socket, body, ack)
```

Declare only the parameters you need. If the client packet has an `id`, returning
a value sends an ack. The third argument is an explicit ack callback for deferred
or error replies.

A handler declaring the third argument and returning `undefined` waits for the
callback within `messageHandlingTimeoutMs`. Other handlers acknowledge their
return value, including `undefined`. Return and callback share a single reply;
duplicate or cancelled callbacks are ignored. Without a packet `id`, no reply
is sent and the dispatcher does not wait for the callback.

Parameter decorators such as `@MessageBody` are not part of the current API.
They can be added later, but the Bun/TC39-compatible path today is positional.

## Current Features

- Namespaces and default paths (`/ws`, `/ws/chat`)
- Rooms via `socket.join(room)` and `socket.to(room).emit(...)`
- Ack frames via return value or explicit `AckCallback`
- Reconnect by `sid` with room restoration
- Missed message replay with transport or client acknowledgement
- Atomic Redis/Valkey session storage and cross-process live pub/sub
- Per-message rate limit
- Optional body validation/transform function
- Upgrade middleware, origin check and token auth hook
- Pluggable codec and adapter interfaces
- Bounded in-process maps for sessions, topics and rate-limit buckets
- Bounded upgrade, per-message and shutdown-drain operations

## Wire Protocol

Client packets are JSON by default:

```ts
{ "v": 1, "type": "event", "event": "echo", "data": "hi", "id": "1" }
```

Server packets include `connected`, `reconnected`, `event`, `ack`, `error` and
`pong`.

The selected codec applies to all frames, including acknowledgements and room
broadcasts. With the default JSON codec, browsers receive text frames; the
binary codec preserves binary framing for automatic, callback and error replies.

Replay uses the actual encoded frame size. A fitting prefix is included in
`reconnected.missed`; the remaining events follow in FIFO order as ordinary
packets before queued client messages run. Only a prefix accepted by the
transport is removed from the session queue. A failed send or an individually
oversized packet closes the connection and retains the unaccepted remainder.
Transport acceptance does not prove client receipt. This is the compatible
default, `replayDelivery: "transport"`.

### Client-confirmed replay

Opt in with `?replay=client-ack` on each connection, or require it for all clients
with `websocketModule({ gateways, replayDelivery: "client-ack" })`. The adapter
must support CAS. A saved client-ack session cannot reconnect in transport mode;
such an upgrade returns 409. Invalid/duplicate replay query values return 400.

In this mode, `connected`/`reconnected` advertise `replayDelivery: "client-ack"`.
Every queued packet has a stable `deliveryId`; `reconnected.replayCount` counts
both its `missed` prefix and subsequent standalone replay packets in the current
bounded batch. The delivery pump continues reading the global mailbox afterward. Process each
received packet, deduplicate its effect by deliveryId, then confirm received IDs:

```ts
ws.send(JSON.stringify({
  v: 1,
  type: "replay-ack",
  id: "receipt-1",
  data: { deliveryIds: [receivedPacket.deliveryId] },
}));
// After persistence: { v: 1, type: "ack", id: "receipt-1",
//                      data: { acknowledged: 1 } }
```

This example uses the JSON codec; binary clients encode the same packet through
their selected codec. Batch IDs where possible, for example after receiving the
advertised replayCount. Split batches to respect the namespace payload bound and
control-frame rate limit. ACK processing waits for replay/open to finish, so do
not block reading subsequent replay frames while waiting for the ACK response.

The server accepts only UUIDs issued to that physical connection. Partial,
out-of-order acknowledgement is supported; repeating an accepted ID on the same
connection acknowledges zero additional packets while it remains in the bounded
recent-ACK window (maxOutboundQueuePerSession for global deliveries). On a new connection, confirm
only the replay actually received there. Disconnecting without acknowledgement
replays the same IDs. The correlation `id` is independent of deliveryId.

The queue retains unacknowledged packets and rejects new entries when full,
instead of evicting old ones. Transport prefix-drain cannot consume it. This
guarantee applies to admitted queued replay within session TTL. Surviving a
process crash also requires completed persistence (`flushSession`) and surviving
storage. Live emits/broadcasts are not automatically durable, and exactly-once
external effects require application-level deduplication.

### Redis / Valkey

Pass an existing native Bun RedisClient from the host infrastructure:

```ts
const adapter = new RedisWebSocketAdapter(hostRedisClient, {
  keyPrefix: "my-app:ws", // same on participating nodes; distinct per application
});
const module = websocketModule({ gateways, adapter, replayDelivery: "client-ack" });
```

The adapter owns only a duplicate connection for pub/sub. Closing the adapter
does not close hostRedisClient or erase persisted sessions. An optional host-owned
deliveryClient separates delivery commands onto another connection; initialization
verifies both clients see the same logical DB using a temporary nonce. Both share
the same native-operation admission limit and remain open after adapter.close().
This option does not establish a throughput guarantee. The adapter uses one Redis
key per SID, Lua CAS/revision checks, a bounded initial-write protection window,
and TTL. Session JSON remains opaque to Lua so empty arrays/null are preserved.
Ordinary SessionManager mutations use CAS too; conflicts fail persistence and
discard the stale local index instead of overwriting a newer owner.
Activity-only writes are coalesced within one third of the smaller TTL/lease
interval. A local touch updates lastSeenAt without extending expiry or lease
until a persisted renewal; expired leases still reject traffic. Room changes,
explicit SessionManager.updateContext calls and delivery acknowledgements retain
their persistence boundaries; arbitrary socket.data mutations are not given a
new automatic persistence contract.

Ordinary emit uses live pub/sub. Reliable room publication uses a separate
persistent mailbox and global room membership for both connected and offline
sessions. Session CAS atomically updates membership; mailbox publish/ACK do not
change the session revision. Polling recovers missed pub/sub notifications.
Empty READ rows are skipped before local session lookup, avoiding one complete
expiry sweep per idle mailbox. Nonempty delivery still checks the current owner,
lease and backpressure after the store read.

### Reliable room publication

```ts
// Generate these once per logical operation and retain them for retries.
const options = { messageId: crypto.randomUUID(), expiresAt: Date.now() + 30_000 };
const receipt = await socket.to("orders").emitReliable("updated", { orderId }, options);
// receipt = { messageId, recipients, duplicate }
```

The gateway authorizes room access. Namespace and sender SID come from the
server. Every recipient must use client-ack. A successful receipt means the
operation was stored for every recipient selected atomically at publication,
including offline sessions on other nodes. It does not mean clients processed
it. Receipt IDs are independent of request correlation IDs.

A transport failure or timeout can occur after commit. Retry the same operation
with exactly the same messageId, expiresAt, room, sender SID and data. The store
suppresses duplicate publication; a reused ID with different content fails with
MESSAGE_ID_CONFLICT. JSON property order is immaterial. The acceptance deadline
must be at most 60 seconds ahead of store time; after expiry, do not retry with
an extended deadline. Queue retention follows session TTL, not that deadline.
Clients deduplicate effects by deliveryId and ACK only after successful processing.

Queue count/byte, fan-out and operation-history limits reject admission before
mailbox writes; no unacknowledged packet is evicted. READ/ACK check the physical
connection owner and live lease. Issued IDs are skipped on subsequent reads;
reconnect issues any remaining packets again. Per-connection issued/recent ACK
sets are bounded. Legacy runtime offline overflow now reports
OFFLINE_QUEUE_CAPACITY instead of hiding truncated delivery behind a successful
handler ACK. Direct legacy SessionManager enqueue compatibility remains available.

Redis strict initialization/readiness requires appendonly=yes,
appendfsync=always, no-appendfsync-on-rewrite=no, maxmemory-policy=noeviction
and healthy AOF write status.
All nodes sharing a prefix must use the same delivery policy. AOF configuration
is an explicit migration requirement; reliable.requireAof=false disables the
durability gate and cannot guarantee storage-crash survival. Host credentials
need CONFIG GET and INFO persistence.
The application should wire runtime.getHealth() into its readiness endpoint and
export getStats().delivery or onDiagnostic counters. No application endpoint is
created by this library change.

The adapter bounds native operations and waiting. A timeout does not cancel
native I/O or free its admission slot; new operations fail STORE_BUSY until the
old native operation settles. Close owns only the subscriber. The host must use
bounded connection/retry/offline-queue settings and supervise process restart.
AOF LOADING is not readiness: keep the application out of traffic until the
store serves commands, then initialize with bounded retries.

Physical evidence and the supported deployment boundary are in the
[enterprise qualification](../../../../docs/audits/2026-09-14-websocket-enterprise/REPORT.md).
The atomic boundary is one Redis primary/replication group. Cross-slot Redis
Cluster, arbitrary automatic replica promotion, WAN and production WSS require
separate deployment evidence. External exactly-once effects remain application-owned.

## Limits

- The default adapter is in-memory and single-node.
- Cross-process pub/sub can use `RedisWebSocketAdapter` or a custom adapter.
- Handler argument binding is positional, not decorator-based.
- `websocketModule({ limits })` tunes in-process memory bounds:
  `maxSessions`, `maxRoomsPerSession`, `maxRoomNameLength`, `maxTopics`,
  `maxRateLimitBuckets` and `maxOutboundQueuePerSession`.
- The complete upgrade, including middleware, authentication and session I/O,
  defaults to a 10 second deadline. Connection initialization after upgrade has
  a separate deadline of the same duration. Message validation/handling defaults
  to 30 seconds, and graceful shutdown drain to 5 seconds.
  Configure `handshakeTimeoutMs`, `messageHandlingTimeoutMs` and
  `shutdownDrainTimeoutMs`; an explicit `0` disables the corresponding deadline.
- `maxBackpressureBytes` defaults to 1 MiB of native outgoing buffer. Large replay
  waits for native drain within the open/message deadline. A runtime-initiated
  close forcibly terminates an unresponsive peer after `socketCloseTimeoutMs`
  (default 1 second). Both limits must be positive.
- `maxConcurrentHandshakes` counts unresolved upgrade operations, and
  `maxConcurrentMessageHandlers` counts unresolved validators/handlers. A timeout
  ends the client's wait but retains the slot until actual success or failure.
  New work fails busy while the limit is occupied. Connection initialization
  after upgrade has its own lifetime and is not an upgrade admission slot.
- `close()` is shared and idempotent, including its failure result. It aborts
  waits and terminates sockets, but disconnect hooks wait for their connection's
  callback, and gateway/adapter cleanup waits for actual work settlement.
  Expiring `shutdownDrainTimeoutMs` rejects close; ordered cleanup continues
  afterwards. A permanently unresolved callback retains its resources until
  process termination. Timeout is not evidence that application effects ended.
- Middleware reads cancellation from `ctx.signal`; validators may accept a
  second `AbortSignal`, authenticators an optional context, and handlers can use
  `socket.signal`. Existing positional handler/authenticator signatures remain
  valid. A timed-out message fails and closes its physical socket; late acks and
  socket mutations are suppressed.
- Messages received immediately after browser `open` wait for session
  persistence and `handleConnection`. The pending-message bound still applies
  during initialization. An initialization timeout closes the connection and
  suppresses queued handlers. Cancellation stops waiting and late activation;
  it cannot roll back I/O already started by an arbitrary adapter.
- Reconnect always enforces the principal stored with the target session,
  including principals established by custom gateway middleware. The optional
  token on a reconnect control packet is additional reauthentication, not the
  switch that enables ownership checks.
- Room names are validated; empty names, names containing the internal separator
  and names longer than the configured limit are rejected.
- Expired sessions and rate-limit buckets are purged during normal operations;
  default rate-limit keys are also forgotten on socket close.
- `InMemoryWebSocketAdapter.maxEntries` caps only live sessions (default 10,000;
  the default runtime adapter uses `limits.maxSessions`). Deletion markers have
  a separate `maxTombstones` cap, defaulting to maxEntries. Older markers compact
  into a creation floor. Immutable runtime creation tokens allow fresh sessions
  in the same millisecond to use freed live capacity while old deleted snapshots
  remain rejected, including higher-revision writes. Existing sessions can still
  be updated. A full live cap raises SessionCapacityError and closes with 1013.
- Compaction conservatively rejects absent snapshots predating its floor,
  including delayed first writes. Legacy/imported states without a local token
  additionally use immutable createdAt and `tombstoneTtlMs` (default 60 seconds)
  as an initial-write window. Such states do not have the runtime's precise
  same-millisecond ordering. SIDs are not reused for different sessions.

The module passport and verification links are in [MODULE.md](MODULE.md).
