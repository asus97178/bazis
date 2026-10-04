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

/** Тюнинг распределённого кэша поверх Redis (всё необязательно). */
export interface RedisDistributedCacheTuning {
  /** Имя соединения для декораторов (`connection`). По умолчанию `"default"`. */
  readonly connection?: string;
  /** Префикс всех ключей — изолирует кэш приложения в общем Redis. */
  readonly keyPrefix?: string;
  /** TTL anti-stampede лока на промахе (секунды). */
  readonly defaultLockSeconds?: number;
  /** Максимальная длина ключа. */
  readonly maxKeyLength?: number;
  /** Лимит размера сериализованного значения (байты); `set` деградирует мягко. */
  readonly maxValueBytes?: number;
  /** Интервал поллинга (мс) при ожидании результата от другого воркера. */
  readonly pollIntervalMs?: number;
}

const DEFAULT_KEY_PREFIX = "osnova:cache:";
const DEFAULT_LOCK_SECONDS = 10;
const DEFAULT_CONNECTION = "default";

/**
 * Распределённый backend кэша поверх одного Redis-соединения. Строит два стора
 * (HTTP-ответы и значения методов) с раздельными namespace и кодеками, отдаёт их
 * как {@link NamedCacheRegistry}. Соединение открывает/закрывает Redis-коннектор
 * `redisConnect(...)`.
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
