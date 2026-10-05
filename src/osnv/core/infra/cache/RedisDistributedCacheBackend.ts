import {
  DistributedCache,
  NamedCacheRegistry,
  httpPayloadCacheCodec,
  jsonCacheCodec,
  type CachedHttpPayload,
  type DistributedCacheStores,
  type DistributedCachePing,
  type IDistributedCache,
} from "../../cache";
import type { RedisCommandClient } from "./RedisDistributedCacheDriver";
import { RedisDistributedCacheDriver } from "./RedisDistributedCacheDriver";

/** Tuning of the Redis-backed distributed cache (all optional). */
export interface RedisDistributedCacheTuning {
  /** Connection name for the decorators (`connection`). Defaults to `"default"`. */
  readonly connection?: string;
  /** Prefix of all keys; isolates the application cache in a shared Redis. */
  readonly keyPrefix?: string;
  /** TTL of the anti-stampede lock on a miss (seconds). */
  readonly defaultLockSeconds?: number;
  /** Maximum key length. */
  readonly maxKeyLength?: number;
  /** Size limit of a serialized value (bytes); `set` degrades gracefully. */
  readonly maxValueBytes?: number;
  /** Polling interval (ms) while waiting for another worker's result. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_KEY_PREFIX = "osnv:cache:";
const DEFAULT_LOCK_SECONDS = 10;
const DEFAULT_CONNECTION = "default";

/**
 * Distributed cache backend on top of one Redis connection. Builds two stores
 * (HTTP responses and method values) with separate namespaces and codecs and
 * exposes them as a {@link NamedCacheRegistry}. The `redisConnect(...)`
 * connector opens and closes the connection.
 */
export class RedisDistributedCacheBackend implements DistributedCacheStores {
  public readonly connectionNames: readonly string[];
  public readonly outputCache: NamedCacheRegistry<IDistributedCache<CachedHttpPayload>>;
  public readonly serviceCache: NamedCacheRegistry<IDistributedCache>;

  private readonly connection: string;

  public constructor(
    private readonly client: RedisCommandClient,
    tuning: RedisDistributedCacheTuning = {},
  ) {
    this.connection = tuning.connection ?? DEFAULT_CONNECTION;
    this.connectionNames = [this.connection];

    const driver = new RedisDistributedCacheDriver(client);
    const base = {
      connectionName: this.connection,
      keyPrefix: tuning.keyPrefix ?? DEFAULT_KEY_PREFIX,
      defaultLockSeconds: tuning.defaultLockSeconds ?? DEFAULT_LOCK_SECONDS,
      maxKeyLength: tuning.maxKeyLength,
      maxValueBytes: tuning.maxValueBytes,
      pollIntervalMs: tuning.pollIntervalMs,
    };

    const output = new DistributedCache<CachedHttpPayload>(driver, httpPayloadCacheCodec, {
      ...base,
      namespace: "out:",
    });
    const service = new DistributedCache(driver, jsonCacheCodec, { ...base, namespace: "svc:" });

    this.outputCache = new NamedCacheRegistry(new Map([[this.connection, output]]));
    this.serviceCache = new NamedCacheRegistry(new Map([[this.connection, service]]));
  }

  public async ping(): Promise<readonly DistributedCachePing[]> {
    try {
      const reply = await this.client.send("PING", []);
      return [{ connection: this.connection, healthy: reply === "PONG" }];
    } catch (error) {
      return [
        {
          connection: this.connection,
          healthy: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  }
}
