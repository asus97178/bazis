import { expect, test } from "bun:test";
import { RedisRoomDeliveryStore } from "../adapter/redis-delivery-store";

// 0.100.5: a Redis that may lose writes is refused with what to change.
// On 0.100.4 the start said only "WebSocket delivery rejected: DURABILITY_CONFIGURATION."

function redis(settings: Record<string, string>, info = "loading:0\r\naof_last_write_status:ok\r\n") {
  return {
    send: async (command: string) => command === "CONFIG" ? Object.entries(settings).flat() : info,
  };
}

test("the durability error names every wrong setting and the value it needs", async () => {
  const store = new RedisRoomDeliveryStore(redis({
    appendonly: "no",
    appendfsync: "everysec",
    "no-appendfsync-on-rewrite": "no",
    "maxmemory-policy": "allkeys-lru",
  }), "test");
  const error = await store.healthCheck().then(() => undefined, (caught: unknown) => caught) as Error & { code: string };
  expect(error.code).toBe("DURABILITY_CONFIGURATION");
  expect(error.message).toBe(
    "WebSocket delivery needs a Redis that does not lose writes: appendonly is no, needs yes; appendfsync is everysec, needs always; "
      + "maxmemory-policy is allkeys-lru, needs noeviction. Set them in redis.conf or with CONFIG SET; otherwise undelivered messages and sessions may be lost.",
  );
});

test("a durable Redis passes, and a failed AOF write is named", async () => {
  const durable = { appendonly: "yes", appendfsync: "always", "no-appendfsync-on-rewrite": "no", "maxmemory-policy": "noeviction" };
  await new RedisRoomDeliveryStore(redis(durable), "test").healthCheck();
  const failed = new RedisRoomDeliveryStore(redis(durable, "loading:0\r\naof_last_write_status:err\r\n"), "test");
  await expect(failed.healthCheck()).rejects.toThrow("the last append-only file write failed (aof_last_write_status)");
});
