import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import { randomUUID } from "node:crypto";
import { RedisDistributedCacheDriver } from "@/core/infra";

/**
 * Opt-in integration coverage for the Redis/Valkey Lua paths.
 *
 *   OSNV_REDIS_TEST_URL="redis://localhost:6379" \
 *     bun test src/osnv/core/infra/test/redisCache.live.test.ts
 *
 * The default test run performs no network I/O because the suite is skipped
 * unless the dedicated URL is provided.
 */
const url = process.env.OSNV_REDIS_TEST_URL;

describe.skipIf(!url)("Redis distributed cache (live)", () => {
  const prefix = `osnv:test:cache:${randomUUID()}:`;
  const keys = {
    entry: `${prefix}entry`,
    lock: `${prefix}lock`,
    version: `${prefix}version`,
    tag: `${prefix}tag`,
    ttlTag: `${prefix}ttl-tag`,
  } as const;
  let client: RedisClient;
  let driver: RedisDistributedCacheDriver;

  beforeAll(async () => {
    client = new RedisClient(url as string);
    await client.connect();
    driver = new RedisDistributedCacheDriver(client);
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.del(...Object.values(keys));
      client.close();
    }
  });

  test("fenced Lua write requires the current lock owner", async () => {
    expect(await driver.acquireLock(keys.lock, "owner", 30)).toBe(true);
    expect(await driver.writeIfLockOwner({
      lockKey: keys.lock,
      lockToken: "owner",
      key: keys.entry,
      value: "first",
      ttlSeconds: 30,
      versionChecks: [{ key: keys.version, expected: null }],
      tags: [{ key: keys.tag, member: "member" }],
    })).toBe(true);
    expect(await driver.writeIfLockOwner({
      lockKey: keys.lock,
      lockToken: "not-owner",
      key: keys.entry,
      value: "stale",
      ttlSeconds: 30,
      versionChecks: [{ key: keys.version, expected: null }],
      tags: [],
    })).toBe(false);
    expect(await driver.read(keys.entry)).toBe("first");
    expect(Number(await client.send("TTL", [keys.tag]))).toBeGreaterThan(0);
    await driver.releaseLock(keys.lock, "owner", keys.version);
  });

  test("invalidation atomically fences a live owner and cleanup removes the tombstone", async () => {
    expect(await driver.acquireLock(keys.lock, "owner", 30)).toBe(true);
    await driver.write(keys.entry, "value", 30);
    expect(await driver.invalidate(keys.version, keys.entry, keys.lock)).toBe(true);
    expect(await driver.read(keys.entry)).toBeNull();
    expect(await driver.read(keys.version)).toBe("1");
    expect(Number(await client.send("PTTL", [keys.version]))).toBeGreaterThan(0);

    await driver.releaseLock(keys.lock, "owner", keys.version);
    expect(await driver.read(keys.lock)).toBeNull();
    expect(await driver.read(keys.version)).toBeNull();
  });

  test("tag TTL is extended but never shortened, and no-TTL membership persists it", async () => {
    await driver.addTagMembers(keys.ttlTag, ["long"], 300);
    expect(Number(await client.send("TTL", [keys.ttlTag]))).toBeGreaterThan(250);
    await driver.addTagMembers(keys.ttlTag, ["short"], 30);
    expect(Number(await client.send("TTL", [keys.ttlTag]))).toBeGreaterThan(250);
    await driver.addTagMembers(keys.ttlTag, ["persistent"]);
    expect(Number(await client.send("TTL", [keys.ttlTag]))).toBe(-1);
    await driver.addTagMembers(keys.ttlTag, ["finite-again"], 30);
    expect(Number(await client.send("TTL", [keys.ttlTag]))).toBe(-1);
  });
});
