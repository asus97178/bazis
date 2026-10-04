import type { DistributedCacheDriver, DistributedCacheFencedWrite } from "../../cache";

/**
 * Узкий контракт Redis-клиента, который нужен драйверу. Bun `RedisClient`
 * удовлетворяет ему структурно — но через интерфейс драйвер тестируется без
 * живого сервера (любой fake реализует эти пять методов).
 */
export interface RedisCommandClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...options: string[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  send(command: string, args: string[]): Promise<unknown>;
}

/**
 * Снимает лок, только если он всё ещё держит наш fencing-token (атомарно).
 * Иначе медленный воркер мог бы удалить лок, который уже перезахватил другой.
 */
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); if KEYS[2] then redis.call('del', KEYS[2]) end; return 1 else return 0 end";

const DELETE_IF_VALUE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const INVALIDATE_SCRIPT =
  "redis.call('incr', KEYS[1]); return redis.call('del', KEYS[2])";

const INVALIDATE_WHILE_LOCKED_SCRIPT =
  "if redis.call('exists', KEYS[3]) == 1 then local lockTtl = redis.call('pttl', KEYS[3]); redis.call('incr', KEYS[1]); if lockTtl > 0 then redis.call('pexpire', KEYS[1], lockTtl + 60000) end else redis.call('del', KEYS[1]) end; return redis.call('del', KEYS[2])";

const ADVANCE_TAG_GENERATION_SCRIPT =
  "local next = redis.call('incr', KEYS[1]); redis.call('sadd', KEYS[2], tostring(next - 1)); return next";

const ADD_TAG_MEMBERS_SCRIPT = `
local previousTtl = redis.call('ttl', KEYS[1])
for i = 2, #ARGV do redis.call('sadd', KEYS[1], ARGV[i]) end
if ARGV[1] == '' then
  redis.call('persist', KEYS[1])
elseif previousTtl == -2 or (previousTtl >= 0 and previousTtl < tonumber(ARGV[1])) then
  redis.call('expire', KEYS[1], ARGV[1])
end
return 1`;

const WRITE_IF_LOCK_OWNER_SCRIPT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
local versionCount = tonumber(ARGV[4])
local tagCount = tonumber(ARGV[5])
for i = 1, versionCount do
  local actual = redis.call('get', KEYS[2 + i])
  local expected = ARGV[5 + i]
  if expected == '__OSNV_MISSING_VERSION__' then
    if actual then return 0 end
  elseif actual ~= expected then
    return 0
  end
end
if ARGV[3] == '' then
  redis.call('set', KEYS[2], ARGV[2])
else
  redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
end
for i = 1, tagCount do
  local tagKey = KEYS[2 + versionCount + i]
  local previousTtl = redis.call('ttl', tagKey)
  redis.call('sadd', tagKey, ARGV[5 + versionCount + i])
  if ARGV[3] == '' then
    redis.call('persist', tagKey)
  elseif previousTtl == -2 or (previousTtl >= 0 and previousTtl < tonumber(ARGV[3])) then
    redis.call('expire', tagKey, ARGV[3])
  end
end
return 1`;

/**
 * Реализация {@link DistributedCacheDriver} поверх Redis/Valkey (нативный Bun
 * `RedisClient`). Только низкоуровневые примитивы — вся политика кэша
 * (anti-stampede, теги, лимиты) живёт в `DistributedCache` ядра.
 */
export class RedisDistributedCacheDriver implements DistributedCacheDriver {
  public constructor(private readonly client: RedisCommandClient) {}

  public read(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  public async write(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds !== undefined) {
      await this.client.set(key, value, "EX", String(ttlSeconds));
    } else {
      await this.client.set(key, value);
    }
  }

  public delete(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return Promise.resolve(0);
    }
    return this.client.del(...keys);
  }

  public async acquireLock(lockKey: string, token: string, ttlSeconds: number): Promise<boolean> {
    const reply = await this.client.set(lockKey, token, "NX", "EX", String(ttlSeconds));
    return reply === "OK";
  }

  public async releaseLock(lockKey: string, token: string, entryVersionKey?: string): Promise<void> {
    const keys = entryVersionKey === undefined ? [lockKey] : [lockKey, entryVersionKey];
    await this.client.send("EVAL", [RELEASE_LOCK_SCRIPT, String(keys.length), ...keys, token]);
  }

  public async writeIfLockOwner(request: DistributedCacheFencedWrite): Promise<boolean> {
    const versionKeys = request.versionChecks.map((check) => check.key);
    const tagKeys = request.tags.map((tag) => tag.key);
    const expectedVersions = request.versionChecks.map((check) => check.expected ?? "__OSNV_MISSING_VERSION__");
    const tagMembers = request.tags.map((tag) => tag.member);
    const keys = [request.lockKey, request.key, ...versionKeys, ...tagKeys];
    const args = [
      request.lockToken,
      request.value,
      request.ttlSeconds === undefined ? "" : String(request.ttlSeconds),
      String(versionKeys.length),
      String(tagKeys.length),
      ...expectedVersions,
      ...tagMembers,
    ];
    const reply = await this.client.send("EVAL", [WRITE_IF_LOCK_OWNER_SCRIPT, String(keys.length), ...keys, ...args]);
    return Number(reply) === 1;
  }

  public async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    const reply = await this.client.send("EVAL", [DELETE_IF_VALUE_SCRIPT, "1", key, expectedValue]);
    return Number(reply) === 1;
  }

  public async increment(key: string): Promise<number> {
    const reply = await this.client.send("INCR", [key]);
    const value = Number(reply);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Redis returned an invalid cache invalidation generation");
    }
    return value;
  }

  public async invalidate(versionKey: string, valueKey: string, lockKey?: string): Promise<boolean> {
    const reply = lockKey === undefined
      ? await this.client.send("EVAL", [INVALIDATE_SCRIPT, "2", versionKey, valueKey])
      : await this.client.send(
        "EVAL",
        [INVALIDATE_WHILE_LOCKED_SCRIPT, "3", versionKey, valueKey, lockKey],
      );
    return Number(reply) > 0;
  }

  public async advanceTagGeneration(versionKey: string, pendingKey: string): Promise<number> {
    const reply = await this.client.send("EVAL", [ADVANCE_TAG_GENERATION_SCRIPT, "2", versionKey, pendingKey]);
    const value = Number(reply);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Redis returned an invalid tag invalidation generation");
    }
    return value;
  }

  public async addTagMembers(tagKey: string, members: readonly string[], ttlSeconds?: number): Promise<void> {
    if (members.length === 0) {
      return;
    }
    await this.client.send("EVAL", [
      ADD_TAG_MEMBERS_SCRIPT,
      "1",
      tagKey,
      ttlSeconds === undefined ? "" : String(ttlSeconds),
      ...members,
    ]);
  }

  public async removeTagMembers(tagKey: string, members: readonly string[]): Promise<void> {
    if (members.length === 0) return;
    await this.client.send("SREM", [tagKey, ...members]);
  }

  public async tagMembers(tagKey: string): Promise<readonly string[]> {
    const reply = await this.client.send("SMEMBERS", [tagKey]);
    return Array.isArray(reply) ? (reply as string[]) : [];
  }
}
