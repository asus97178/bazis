import { describe, expect, spyOn, test } from "bun:test";
import { InMemoryWebSocketAdapter } from "../adapter/in-memory.adapter";
import { SessionManager } from "../session-manager";
import { jsonPacketCodec } from "../codec/json.codec";
import { binaryPacketCodec } from "../codec/binary.codec";
import type { ServerPacket } from "../types";
import { startWebSocketFixture, testNamespace, until } from "./reliability.fixture";

const event = (name: string): ServerPacket => ({ v: 1, type: "event", event: name, data: "x".repeat(220) });
const replay = (frames: ServerPacket[]) => frames.flatMap((frame) => frame.type === "reconnected" ? frame.missed ?? [] : frame.type === "event" ? [frame] : []);

describe("WebSocket: client-confirmed replay", () => {
  for (const codec of [jsonPacketCodec, binaryPacketCodec]) {
    test(`${codec.name}: interrupted replay retains stable identities until client ACK`, async () => {
      const adapter = new InMemoryWebSocketAdapter();
      const sessions = new SessionManager({ adapter });
      sessions.createSession("reliable", "/reliability", {}, undefined, "client-ack");
      for (const name of ["one", "two", "three"]) sessions.enqueueOutbound("reliable", event(name));
      await sessions.flushAll();
      const app = await startWebSocketFixture({ namespaces: [testNamespace({ maxPayloadBytes: 512 })], adapter, codec });
      try {
        const first = await app.connect("?sid=reliable&replay=client-ack");
        await until(() => replay(first.frames).length === 3);
        const issued = replay(first.frames);
        expect(new Set(issued.map((packet) => packet.deliveryId)).size).toBe(3);
        expect(first.frames[0]?.replayDelivery).toBe("client-ack");
        expect((await adapter.loadSession("reliable"))?.outboundQueue).toEqual(issued);
        await first.close();
        const second = await app.connect("?sid=reliable&replay=client-ack");
        await until(() => replay(second.frames).length === 3);
        expect(replay(second.frames)).toEqual(issued);
        second.send({ type: "replay-ack", id: "partial", data: { deliveryIds: [issued[1]!.deliveryId] } });
        await until(() => second.frames.some((packet) => packet.id === "partial"));
        expect(second.frames.find((packet) => packet.id === "partial")?.data).toEqual({ acknowledged: 1 });
        second.send({ type: "replay-ack", id: "duplicate", data: { deliveryIds: [issued[1]!.deliveryId] } });
        await until(() => second.frames.some((packet) => packet.id === "duplicate"));
        expect(second.frames.find((packet) => packet.id === "duplicate")?.data).toEqual({ acknowledged: 0 });
        await second.close();
        const third = await app.connect("?sid=reliable&replay=client-ack");
        await until(() => replay(third.frames).length === 2);
        expect(replay(third.frames).map((packet) => packet.deliveryId)).toEqual([issued[0]!.deliveryId, issued[2]!.deliveryId]);
        third.send({ type: "replay-ack", id: "all", data: { deliveryIds: replay(third.frames).map((packet) => packet.deliveryId) } });
        await until(() => third.frames.some((packet) => packet.id === "all"));
        expect((await adapter.loadSession("reliable"))?.outboundQueue).toEqual([]);
      } finally { await app.close(); }
    });
  }

  test("unissued receipts and malformed IDs cannot consume another session's queue", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const sessions = new SessionManager({ adapter });
    sessions.createSession("owned", "/reliability", {}, undefined, "client-ack");
    sessions.enqueueOutbound("owned", event("secret"));
    await sessions.flushAll();
    const id = sessions.peekOutbound("owned")[0]!.deliveryId;
    const app = await startWebSocketFixture({ namespaces: [testNamespace()], adapter });
    try {
      const peer = await app.connect("?replay=client-ack");
      const bad = [[id], [], [null], ["x"], [crypto.randomUUID()]];
      for (const [index, deliveryIds] of bad.entries()) {
        peer.send({ type: "replay-ack", id: `bad-${index}`, data: { deliveryIds } });
        await until(() => peer.frames.some((packet) => packet.id === `bad-${index}`));
        expect(peer.frames.find((packet) => packet.id === `bad-${index}`)?.type).toBe("error");
      }
      expect((await adapter.loadSession("owned"))?.outboundQueue).toHaveLength(1);
      const response = await fetch(app.url.replace("ws:", "http:") + "?sid=owned", { headers: { upgrade: "websocket" } });
      expect(response.status).toBe(409);
    } finally { await app.close(); }
  });

  test("control reconnect negotiates persistent receipts and rejects transport downgrade", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const sessions = new SessionManager({ adapter });
    sessions.createSession("legacy", "/reliability", {});
    sessions.enqueueOutbound("legacy", event("migrate"));
    await sessions.flushAll();
    const app = await startWebSocketFixture({ namespaces: [testNamespace()], adapter });
    try {
      const peer = await app.connect("?replay=client-ack");
      peer.send({ type: "reconnect", data: { sid: "legacy" } });
      await until(() => replay(peer.frames).length === 1);
      expect(replay(peer.frames)[0]?.deliveryId).toBeString();
      expect((await adapter.loadSession("legacy"))?.replayDelivery).toBe("client-ack");
      const legacy = await app.connect();
      legacy.send({ type: "reconnect", id: "downgrade", data: { sid: "legacy" } });
      await until(() => legacy.frames.some((packet) => packet.id === "downgrade"));
      expect(legacy.frames.find((packet) => packet.id === "downgrade")?.type).toBe("error");
      expect((await adapter.loadSession("legacy"))?.outboundQueue).toHaveLength(1);
    } finally { await app.close(); }
  });

  test("a full reliable queue rejects new packets instead of discarding unacknowledged data", () => {
    const manager = new SessionManager({ maxOutboundQueue: 1 });
    manager.createSession("bounded", "/reliability", {}, undefined, "client-ack");
    expect(manager.enqueueOutbound("bounded", event("first"))).toBe(true);
    const pending = manager.peekOutbound("bounded");
    expect(manager.enqueueOutbound("bounded", event("second"))).toBe(false);
    expect(manager.peekOutbound("bounded")).toEqual(pending);
    expect(() => manager.drainOutbound("bounded")).toThrow();
    expect(manager.peekOutbound("bounded")).toEqual(pending);
  });

  test("required delivery mode and invalid negotiation fail before upgrade", async () => {
    const app = await startWebSocketFixture({ namespaces: [testNamespace()], replayDelivery: "client-ack" });
    try {
      for (const [query, status] of [["?replay=transport", 409], ["?replay=invalid", 400], ["?replay=client-ack&replay=transport", 400]] as const) {
        expect((await fetch(app.url.replace("ws:", "http:") + query, { headers: { upgrade: "websocket" } })).status).toBe(status);
      }
      expect((await app.connect()).frames[0]?.replayDelivery).toBe("client-ack");
    } finally { await app.close(); }
  });
});

describe("WebSocket: bounded history and stale writers", () => {
  test("a deletion marker rejects higher-revision saves and CAS before compaction", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const manager = new SessionManager({ adapter });
    manager.createSession("deleted", "/reliability", {});
    await manager.flushAll();
    const stale = (await adapter.loadSession("deleted"))!;
    manager.deleteSession("deleted");
    await manager.flushAll();
    await adapter.saveSession({ ...stale, revision: 999 });
    expect(await adapter.loadSession("deleted")).toBeNull();
    expect(await adapter.compareAndSwapSession({ ...stale, revision: 999 }, stale.revision! + 1)).toBe(false);
    expect(await adapter.loadSession("deleted")).toBeNull();
    await adapter.close();
  });

  test("same-millisecond churn never spends live capacity on deletion history", async () => {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const adapter = new InMemoryWebSocketAdapter({ maxEntries: 1, maxTombstones: 3 });
    const manager = new SessionManager({ adapter, maxSessions: 1 });
    let oldest;
    try {
      for (let index = 0; index < 1000; index++) {
        const state = manager.createSession(`churn-${index}`, "/reliability", {});
        await manager.flushAll();
        expect(await adapter.loadSession(state.sid)).not.toBeNull();
        oldest ??= structuredClone(state);
        manager.deleteSession(state.sid);
        await manager.flushAll();
        expect((adapter as unknown as { tombstones: Map<string, unknown> }).tombstones.size).toBeLessThanOrEqual(3);
      }
      await adapter.saveSession({ ...oldest!, revision: 999 });
      expect(await adapter.loadSession(oldest!.sid)).toBeNull();
      expect(adapter.sessionCount()).toBe(0);
    } finally { clock.mockRestore(); await adapter.close(); }
  });

  test("ordinary updates use CAS and cannot overwrite a newer remote owner", async () => {
    const adapter = new InMemoryWebSocketAdapter();
    const manager = new SessionManager({ adapter });
    manager.createSession("shared", "/reliability", {});
    await manager.flushAll();
    const state = (await adapter.loadSession("shared"))!;
    expect(await adapter.compareAndSwapSession({ ...state, revision: 2, context: { owner: "remote" } }, 1)).toBe(true);
    manager.updateContext("shared", { owner: "stale" });
    await expect(manager.flushSession("shared")).rejects.toThrow("revision conflict");
    expect((await adapter.loadSession("shared"))?.context).toEqual({ owner: "remote" });
    expect(manager.getStats().sessions).toBe(0);
    await adapter.close();
  });
});
