import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { InMemoryWebSocketAdapter, RedisWebSocketAdapter, SessionManager, type OsnovaSocket, type WebSocketDiagnostic, type ReliableRoomDelivery, type ServerPacket } from "../index";
import { RedisWebSocketOperations } from "../adapter/redis-operations";
import { testNamespace, testHandler, startWebSocketFixture, until } from "./reliability.fixture";

const url = process.env.OSNV_WS_TEST_REDIS_URL;
const live = url ? describe : describe.skip;
const publication = (room = "shared") => ({ messageId: crypto.randomUUID(), expiresAt: Date.now() + 30_000,
  namespace: "/reliability", room, excludeSid: "publisher", packet: { v: 1 as const, type: "event" as const, event: "notice", data: { value: [] } } });

test("timed-out Redis work retains its admission slot until native settlement", async () => {
  let settle!: (value: unknown) => void;
  let calls = 0;
  const operations = new RedisWebSocketOperations({ send: () => { calls++; return new Promise((resolve) => { settle = resolve; }); } } as unknown as RedisClient, 10, 1);
  await expect(operations.send("PING", [])).rejects.toThrow("STORE_TIMEOUT");
  for (let i = 0; i < 100; i++) await expect(operations.send("PING", [])).rejects.toThrow("STORE_BUSY");
  expect(calls).toBe(1);
  settle("PONG"); await Bun.sleep(1);
  const retry = operations.send("PING", []);
  await until(() => calls === 2);
  settle("PONG"); expect(await retry).toBe("PONG");
});

test("active traffic coalesces persistence without extending an unpersisted or expired lease", async () => {
  const adapter = new InMemoryWebSocketAdapter();
  const sessions = new SessionManager({ adapter, activeLeaseMs: 3000, defaultTtlMs: 6000 });
  const realNow = Date.now; let clock = realNow();
  Date.now = () => clock;
  try {
    sessions.createSession("traffic", "/reliability", {});
    await sessions.flushAll();
    expect(await sessions.claimActiveConnection("traffic", "physical")).toBe(true);
    const initial = (await adapter.loadSession("traffic"))!;
    for (let i = 0; i < 100; i++) { clock++; expect(sessions.touchSession("traffic", "physical")).toBe(true); await sessions.flushSession("traffic"); }
    expect((await adapter.loadSession("traffic"))?.revision).toBe(initial.revision);
    expect(sessions.getSession("traffic")?.activeLeaseExpiresAt).toBe(initial.activeLeaseExpiresAt);
    clock += 1000;
    expect(sessions.touchSession("traffic", "physical")).toBe(true); await sessions.flushSession("traffic");
    const renewed = (await adapter.loadSession("traffic"))!;
    expect(renewed.revision).toBe(initial.revision! + 1);
    expect(renewed.activeLeaseExpiresAt).toBe(clock + 3000);
    clock = renewed.activeLeaseExpiresAt! + 1;
    expect(sessions.touchSession("traffic", "physical")).toBe(false);
    await sessions.flushSession("traffic");
    expect((await adapter.loadSession("traffic"))?.revision).toBe(renewed.revision);
  } finally { Date.now = realNow; await adapter.close(); }
});

test("scheduled renewal spreads writes and renews every owner before lease or shorter session TTL expires", async () => {
  const adapter = new InMemoryWebSocketAdapter();
  const sessions = new SessionManager({ adapter, activeLeaseMs: 3000, defaultTtlMs: 6000 });
  const realNow = Date.now; const start = realNow(); let clock = start;
  Date.now = () => clock;
  try {
    const sids = Array.from({ length: 120 }, (_, i) => `lease-${i}`);
    for (const sid of sids) { sessions.createSession(sid, "/reliability", {}); await sessions.flushSession(sid); await sessions.claimActiveConnection(sid, sid); }
    const initial = new Map(sids.map((sid) => [sid, sessions.getSession(sid)!.revision!]));
    const seen = new Set<string>(); let peak = 0;
    clock = start + 999;
    await sessions.renewOwnedLeases({ afterMs: 1000, spreadMs: 1000 });
    expect(sids.every((sid) => sessions.getSession(sid)!.revision === initial.get(sid))).toBe(true);
    for (clock = start + 1000; clock <= start + 2100; clock += 100) {
      expect(await sessions.renewOwnedLeases({ afterMs: 1000, spreadMs: 1000 })).toEqual([]);
      let firstRenewals = 0;
      for (const sid of sids) if (!seen.has(sid) && sessions.getSession(sid)!.revision! > initial.get(sid)!) { seen.add(sid); firstRenewals++; }
      peak = Math.max(peak, firstRenewals);
    }
    expect(seen.size).toBe(120); expect(peak).toBeLessThan(60);
    sessions.createSession("short-ttl", "/reliability", {}, 600);
    await sessions.flushSession("short-ttl"); await sessions.claimActiveConnection("short-ttl", "short");
    clock += 450;
    await sessions.renewOwnedLeases({ afterMs: 1000, spreadMs: 1000 });
    expect((await adapter.loadSession("short-ttl"))?.expiresAt).toBe(clock + 600);
    await expect(sessions.renewOwnedLeases({ afterMs: -1, spreadMs: 1 })).rejects.toThrow("Invalid lease renewal schedule");
  } finally { Date.now = realNow; await adapter.close(); }
});

test("idle mailbox polling does not repeat a full session sweep for every connection", async () => {
  let pending: { sid: string; packet: ServerPacket } | undefined;
  const reliableRooms: ReliableRoomDelivery = {
    async publish() { throw new Error("not used"); },
    async acknowledge() { return 0; },
    async readPending(owners) {
      return owners.map(({ sid }) => ({ sid, packets: pending?.sid === sid ? [pending.packet] : [] }));
    },
  };
  const adapter = Object.assign(new InMemoryWebSocketAdapter(), { reliableRooms });
  const app = await startWebSocketFixture({ adapter, namespaces: [testNamespace()], replayDelivery: "client-ack",
    limits: { reliablePollIntervalMs: 60000, maxHandshakeAttemptsPerWindow: 10000 } });
  const runtime = app.runtime as any;
  const sessions = runtime.sessionManager as SessionManager;
  const purge = sessions.purgeExpired.bind(sessions);
  let sweeps = 0;
  try {
    const peers: Array<Awaited<ReturnType<typeof app.connect>>> = [];
    for (let i = 0; i < 64; i++) peers.push(await app.connect());
    await until(() => !runtime.deliveryInFlight);
    const sids = peers.map((peer) => peer.frames[0]!.sid!);
    sessions.purgeExpired = () => { sweeps++; return purge(); };
    runtime.queueDeliveries(sids);
    await until(() => !runtime.deliveryInFlight);
    expect(sweeps).toBe(0);
    pending = { sid: sids.at(-1)!, packet: { v: 1, type: "event", event: "notice", deliveryId: crypto.randomUUID() } };
    runtime.queueDeliveries(sids);
    await until(() => peers.at(-1)!.frames.some((packet) => packet.deliveryId === pending!.packet.deliveryId));
    expect(sweeps).toBe(1);
    expect(peers.slice(0, -1).every((peer) => peer.frames.every((packet) => !packet.deliveryId))).toBe(true);
  } finally { sessions.purgeExpired = purge; await app.close(); }
});

test("legacy offline overflow is an application error and diagnostic, never a successful handler ACK", async () => {
  const adapter = new InMemoryWebSocketAdapter();
  const seed = new SessionManager({ adapter });
  seed.createSession("offline", "/reliability", {}, undefined, "client-ack");
  seed.updateRooms("offline", ["shared"]);
  seed.enqueueOutbound("offline", { v: 1, type: "event", event: "kept" });
  await seed.flushAll();
  const events: WebSocketDiagnostic[] = [];
  const app = await startWebSocketFixture({ adapter, limits: { maxOutboundQueuePerSession: 1 }, onDiagnostic: (event) => { events.push(event); throw new Error("observer"); },
    namespaces: [testNamespace({ handlers: new Map([["publish", testHandler("publish", (socket: OsnovaSocket) => { socket.to("shared").emit("new"); return true; })]]) })] });
  try {
    // Restore the local offline room index through the public reconnect path.
    const offline = await app.connect("?sid=offline&replay=client-ack"); await offline.close();
    const sender = await app.connect();
    sender.send({ type: "event", event: "publish", id: "publish" });
    await until(() => sender.frames.some((packet) => packet.id === "publish"));
    expect(sender.frames.find((packet) => packet.id === "publish")?.type).toBe("error");
    expect(sender.frames.find((packet) => packet.id === "publish")?.data).toMatchObject({ code: "OFFLINE_QUEUE_CAPACITY" });
    expect(events.some((event) => event.type === "queue-rejected")).toBe(true);
    expect(app.runtime.getStats().delivery["queue-rejected"]).toBe(1);
    expect((await adapter.loadSession("offline"))?.outboundQueue[0]?.event).toBe("kept");
  } finally { await app.close(); }
});

live("WebSocket enterprise: real shared delivery store", () => {
  async function fixture(options: ConstructorParameters<typeof RedisWebSocketAdapter>[1] = {}) {
    const client = new RedisClient(url!, { connectionTimeout: 1000, enableOfflineQueue: false, maxRetries: 0 });
    await client.connect();
    const prefix = `ws-ent-${crypto.randomUUID()}`;
    const adapter = new RedisWebSocketAdapter(client, { ...options, keyPrefix: prefix });
    await adapter.initialize({ localPublish() {} });
    return { client, prefix, adapter, async close() {
      await adapter.close();
      const keys = await client.send("KEYS", [`${prefix}:*`]) as string[];
      if (keys.length) await client.send("DEL", keys);
      client.close();
    } };
  }

  test("global offline fan-out is idempotent, bounded, namespace-isolated and owner-fenced", async () => {
    const f = await fixture({ reliable: { maxQueueMessages: 1 } });
    try {
      const remote = new SessionManager({ adapter: f.adapter });
      for (const sid of ["one", "two"]) {
        remote.createSession(sid, "/reliability", {}, undefined, "client-ack"); remote.updateRooms(sid, ["shared"]);
      }
      remote.createSession("other", "/other", {}, undefined, "client-ack"); remote.updateRooms("other", ["shared"]);
      await remote.flushAll();
      const request = publication();
      expect(await f.adapter.reliableRooms.publish(request)).toEqual({ messageId: request.messageId, recipients: 2, duplicate: false });
      expect((await f.adapter.reliableRooms.publish(request)).duplicate).toBe(true);
      await expect(f.adapter.reliableRooms.publish({ ...request, packet: { ...request.packet, data: "changed" } })).rejects.toThrow("MESSAGE_ID_CONFLICT");
      await expect(f.adapter.reliableRooms.publish(publication())).rejects.toThrow("QUEUE_CAPACITY");
      expect(await remote.claimActiveConnection("one", "conn-one")).toBe(true);
      const owner = { sid: "one", connId: "conn-one", ownerInstanceId: f.adapter.instanceId };
      const batches = await f.adapter.reliableRooms.readPending([owner]);
      expect(batches[0]?.packets.map((packet) => packet.deliveryId)).toEqual([request.messageId]);
      expect(batches[0]?.packets[0]?.data).toEqual({ value: [] });
      await expect(f.adapter.reliableRooms.acknowledge({ ...owner, connId: "stale" }, [request.messageId])).rejects.toThrow("OWNERSHIP_LOST");
      expect(await f.adapter.reliableRooms.acknowledge(owner, [request.messageId])).toBe(1);
      expect(await f.adapter.reliableRooms.acknowledge(owner, [request.messageId])).toBe(0);
      // The second queue is still full: rejection cannot append to the first.
      await expect(f.adapter.reliableRooms.publish(publication())).rejects.toThrow("QUEUE_CAPACITY");
      expect((await f.adapter.reliableRooms.readPending([owner]))[0]?.packets).toEqual([]);
      expect(await f.client.send("EXISTS", [`${f.prefix}:delivery:other`])).toBe(0);
      remote.deleteSession("two"); await remote.flushAll();
      expect(await f.client.send("EXISTS", [`${f.prefix}:delivery:two`])).toBe(0);
      // Acceptance deadlines use the store clock, not a 1ms host/VM alignment.
      const [seconds, micros] = await f.client.send("TIME", []) as string[];
      const storeNow = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
      await expect(f.adapter.reliableRooms.publish({ ...publication(), expiresAt: storeNow - 1 })).rejects.toThrow("EXPIRED_PUBLICATION");
    } finally { await f.close(); }
  });

  test("a separate host-owned delivery client must share the same logical store and survives adapter close", async () => {
    const f = await fixture();
    await f.adapter.close();
    const lane = await f.client.duplicate();
    try {
      const adapter = new RedisWebSocketAdapter(f.client, { keyPrefix: f.prefix, deliveryClient: lane });
      await adapter.initialize({ localPublish() {} });
      await adapter.close();
      expect(f.client.connected).toBe(true); expect(lane.connected).toBe(true);
      // Any logical database other than the one the URL selects (default 0).
      const current = Number(new URL(url!).pathname.slice(1) || "0");
      await lane.send("SELECT", [String(current === 1 ? 2 : 1)]);
      const mismatch = new RedisWebSocketAdapter(f.client, { keyPrefix: f.prefix, deliveryClient: lane });
      await expect(mismatch.initialize({ localPublish() {} })).rejects.toThrow("DELIVERY_STORE_MISMATCH");
      expect(await f.client.send("KEYS", [`${f.prefix}:connection-check:*`])).toEqual([]);
      expect(await lane.send("GET", [`${f.prefix}:delivery-policy`])).toBeNull();
    } finally { lane.close(); await f.close(); }
  });

  test("room membership persists before join ACK, offline recipients on another node receive replay, lost notifications recover by polling", async () => {
    const f = await fixture();
    await f.adapter.close();
    const targetAdapter = new RedisWebSocketAdapter(f.client, { keyPrefix: f.prefix });
    // Deliberately drop advisory notifications; persistent polling is authoritative.
    const initialize = targetAdapter.initialize.bind(targetAdapter);
    targetAdapter.initialize = (hooks) => initialize({ localPublish: hooks.localPublish });
    const namespace = testNamespace({ handlers: new Map([
      ["join", testHandler("join", (socket: OsnovaSocket) => { socket.join("shared"); return true; })],
      ["reliable", testHandler("reliable", (socket: OsnovaSocket, options: { messageId: string; expiresAt: number }) => socket.to("shared").emitReliable("notice", [], options))],
    ]) });
    const first = await startWebSocketFixture({ adapter: f.adapter, namespaces: [namespace], replayDelivery: "client-ack" });
    const second = await startWebSocketFixture({ adapter: targetAdapter, namespaces: [namespace], replayDelivery: "client-ack", limits: { reliablePollIntervalMs: 20 } });
    try {
      const sender = await first.connect(); const peer = await second.connect();
      peer.send({ type: "event", event: "join", id: "join" });
      await until(() => peer.frames.some((packet) => packet.id === "join"));
      const sid = peer.frames[0]!.sid!;
      const liveRequest = publication(); sender.send({ type: "event", event: "reliable", id: "first", data: liveRequest });
      await until(() => peer.frames.some((packet) => packet.deliveryId === liveRequest.messageId));
      expect(sender.frames.find((packet) => packet.id === "first")?.data).toMatchObject({ recipients: 1 });
      await peer.close();
      const offlineRequest = publication(); sender.send({ type: "event", event: "reliable", id: "second", data: offlineRequest });
      await until(() => sender.frames.some((packet) => packet.id === "second"));
      const restored = await first.connect(`?sid=${sid}`);
      expect(restored.frames[0]?.missed?.map((packet) => packet.deliveryId)).toEqual([liveRequest.messageId, offlineRequest.messageId]);
      restored.send({ type: "replay-ack", id: "receipt", data: { deliveryIds: [liveRequest.messageId, offlineRequest.messageId] } });
      await until(() => restored.frames.some((packet) => packet.id === "receipt"));
      expect(restored.frames.find((packet) => packet.id === "receipt")?.data).toEqual({ acknowledged: 2 });
      expect(await f.client.send("LLEN", [`${f.prefix}:delivery:${sid}`])).toBe(0);
      expect(await first.runtime.getHealth()).toEqual({ ready: true });
    } finally { await first.close(); await second.close(); await f.close(); }
  });

  test("an issued unacknowledged queue cannot consume another recipient's read budget", async () => {
    const f = await fixture({ reliable: { maxQueueBytes: 1024, maxReadBytes: 1024 } });
    try {
      const sessions = new SessionManager({ adapter: f.adapter });
      const owners = [];
      for (const sid of ["first", "second"]) {
        sessions.createSession(sid, "/reliability", {}, undefined, "client-ack");
        sessions.updateRooms(sid, ["shared"]);
        await sessions.flushSession(sid);
        expect(await sessions.claimActiveConnection(sid, sid)).toBe(true);
        owners.push({ sid, connId: sid, ownerInstanceId: f.adapter.instanceId });
      }
      const base = publication();
      const request = { ...base, packet: { ...base.packet, data: { value: ["x".repeat(550)] } } };
      await f.adapter.reliableRooms.publish(request);
      const first = await f.adapter.reliableRooms.readPending(owners);
      expect(first.map((row) => row.packets.length)).toEqual([1, 0]);
      const next = await f.adapter.reliableRooms.readPending([{ ...owners[0]!, issuedIds: [request.messageId] }, owners[1]!]);
      expect(next.map((row) => row.packets.length)).toEqual([0, 1]);
      expect(next[1]?.packets[0]?.deliveryId).toBe(request.messageId);
      expect(await f.client.send("LLEN", [`${f.prefix}:delivery:first`])).toBe(1);
    } finally { await f.close(); }
  });
});
