import { describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { RedisWebSocketAdapter } from "../adapter/redis.adapter";
import { SessionManager } from "../session-manager";
import { until } from "./reliability.fixture";

const url = process.env.OSNV_WS_TEST_REDIS_URL;
const live = url ? describe : describe.skip;

live("WebSocket Redis/Valkey: physical adapter", () => {
  test("preserves arrays and nulls, atomically arbitrates writers, and rejects stale resurrection", async () => {
    const client = new RedisClient(url!);
    await client.connect();
    const prefix = `ws-live-${crypto.randomUUID()}`;
    const first = new RedisWebSocketAdapter(client, { keyPrefix: prefix, writeProtectionMs: 80 });
    const second = new RedisWebSocketAdapter(client, { keyPrefix: prefix, writeProtectionMs: 80 });
    try {
      const sessions = new SessionManager({ adapter: first });
      const state = sessions.createSession("cas", "/reliability", { arrays: [], nullValue: null }, 1000);
      await sessions.flushAll();
      const initial = (await first.loadSession("cas"))!;
      expect(initial.outboundQueue).toEqual([]);
      expect(initial.rooms).toEqual([]);
      expect(initial.context).toEqual({ arrays: [], nullValue: null });
      const results = await Promise.all([
        first.compareAndSwapSession({ ...initial, revision: 2, context: { winner: "first" } }, 1),
        second.compareAndSwapSession({ ...initial, revision: 2, context: { winner: "second" } }, 1),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      await first.saveSession(initial);
      expect((await first.loadSession("cas"))?.revision).toBe(2);
      await first.deleteSession("cas", 3);
      await first.saveSession(state);
      expect(await first.loadSession("cas")).toBeNull();
      await Bun.sleep(90);
      await second.saveSession(initial);
      expect(await second.loadSession("cas")).toBeNull();
      expect(await second.compareAndSwapSession({ ...initial, revision: 4 }, 0)).toBe(false);
    } finally {
      await client.send("DEL", [`${prefix}:session:cas`]);
      await first.close(); await second.close(); client.close();
    }
  });

  test("cross-node pub/sub excludes the origin and close keeps the host client and sessions alive", async () => {
    const client = new RedisClient(url!);
    await client.connect();
    const prefix = `ws-live-${crypto.randomUUID()}`;
    const first = new RedisWebSocketAdapter(client, { keyPrefix: prefix });
    const second = new RedisWebSocketAdapter(client, { keyPrefix: prefix });
    const source: string[] = [];
    const target: string[] = [];
    try {
      await first.initialize({ localPublish: (_topic, payload) => source.push(new TextDecoder().decode(payload)) });
      await second.initialize({ localPublish: (_topic, payload) => target.push(new TextDecoder().decode(payload)) });
      const sessions = new SessionManager({ adapter: first });
      sessions.createSession("survives", "/reliability", {}, 1000, "client-ack");
      sessions.enqueueOutbound("survives", { v: 1, type: "event", event: "kept", data: [] });
      await sessions.flushAll();
      await first.publish("/reliability\0room", new TextEncoder().encode("hello"));
      await until(() => target.length === 1);
      expect(source).toEqual([]);
      expect(target).toEqual(["hello"]);
      await first.close();
      expect(await client.ping()).toBe("PONG");
      expect((await second.loadSession("survives"))?.outboundQueue[0]?.data).toEqual([]);
      expect((await second.loadSession("survives"))?.outboundQueue[0]?.deliveryId).toBeString();
    } finally {
      await first.close(); await second.close();
      await client.send("DEL", [`${prefix}:session:survives`]); client.close();
    }
  });
});
