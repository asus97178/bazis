import { RedisClient } from "bun";
import {
  DISTRIBUTED_CACHE_BACKEND,
  DISTRIBUTED_OUTPUT_CACHE,
  DISTRIBUTED_SERVICE_CACHE,
  type DistributedCacheStores,
} from "../../cache";
import { createToken, DI, type InjectionToken, type ProviderDefinition } from "../../di";
import type { AppConfig, Secret } from "../../kernel";
import { RedisDistributedCacheBackend, type RedisDistributedCacheTuning } from "../cache/RedisDistributedCacheBackend";
import { reader, requireValue } from "../connectorConfig";
import { errorMessage, InfraError, type InfraConnector } from "../InfraConnector";

/** Клиент Redis/Valkey (нативный Bun `RedisClient`, без внешних зависимостей). */
export const REDIS: InjectionToken<RedisClient> = createToken<RedisClient>("Redis");

/**
 * Интерфейс конфига, который требует коннектор Redis. Конфиг подсистемы
 * (`defineConfig<RedisConfig>("redis", ...)`) должен предоставлять эти ключи.
 */
export interface RedisConfigShape {
  /** Полная строка подключения, напр. `redis://localhost:6379`. */
  readonly url: string | Secret;
}

export type RedisConnectorCacheMode =
  | "distributed"
  | ({ readonly mode: "distributed" } & RedisDistributedCacheTuning);

export interface RedisConnectorOptions {
  readonly token?: InjectionToken<RedisClient>;
  /**
   * Опубликовать поверх клиента распределённый кэш-бэкенд: `{ cache: "distributed" }`.
   * Для тонкого тюнинга используйте `{ cache: { mode: "distributed", keyPrefix, ... } }`.
   * В приложении допускается один backend; второй отклоняется при сборке контейнера.
   */
  readonly cache?: RedisConnectorCacheMode;
}

/**
 * Провайдеры распределённого кэша поверх Redis-клиента: бэкенд + два реестра
 * (HTTP-ответы и значения методов). Cache-модуль подхватывает их из DI.
 */
function distributedCacheProviders(tuning: RedisDistributedCacheTuning, token: InjectionToken<RedisClient>): ProviderDefinition[] {
  return [
    DI.singleton(
      DI.factoryProvider(
        DISTRIBUTED_CACHE_BACKEND,
        [token],
        (client: RedisClient) => new RedisDistributedCacheBackend(client, tuning),
      ),
    ),
    DI.singleton(
      DI.factoryProvider(DISTRIBUTED_OUTPUT_CACHE, [DISTRIBUTED_CACHE_BACKEND], (backend: DistributedCacheStores) =>
        backend.outputCache,
      ),
    ),
    DI.singleton(
      DI.factoryProvider(DISTRIBUTED_SERVICE_CACHE, [DISTRIBUTED_CACHE_BACKEND], (backend: DistributedCacheStores) =>
        backend.serviceCache,
      ),
    ),
  ];
}

/**
 * Коннектор Redis для манифеста `@Infra`. Конфигурация берётся из переданного
 * `redisConfig` (`defineConfig("redis", ...)`) — коннектор читает объявленный
 * ключ `url`. Открывает соединение на старте, закрывает на стопе. Вторым
 * аргументом — опции коннектора (распределённый кэш и т. п.).
 *
 * ```ts
 * export const redisConfig = defineConfig("redis", { default: { url: "redis://localhost:6379" } });
 * @Infra({ cache: redisConnect(redisConfig, { cache: "distributed" }) })
 * export class AppInfra {}
 * // инъекция: constructor(private readonly redis: RedisClient) {}  // токен REDIS
 * ```
 */
export function redisConnect<T extends RedisConfigShape>(
  config: AppConfig<T>,
  options: RedisConnectorOptions = {},
): InfraConnector<RedisClient> {
  const cache = options.cache;
  const token = options.token ?? REDIS;
  const cacheProviders =
    cache === undefined
      ? undefined
      : distributedCacheProviders(cache === "distributed" ? {} : withoutMode(cache), token);

  return {
    token,
    config,
    providers: cacheProviders,
    exports: cacheProviders ? [DISTRIBUTED_CACHE_BACKEND, DISTRIBUTED_OUTPUT_CACHE, DISTRIBUTED_SERVICE_CACHE] : undefined,
    create(configs) {
      return new RedisClient(redisUrl(reader(config, configs).get("url")));
    },
    async connect(client) {
      try {
        await client.connect();
      } catch (error) {
        throw new InfraError(`Infra connector "redis": failed to connect — ${errorMessage(error)}`);
      }
    },
    dispose(client) {
      client.close();
    },
    async healthCheck(client) {
      try {
        return (await client.ping()) === "PONG";
      } catch {
        return false;
      }
    },
  };
}

function redisUrl(value: unknown): string {
  if (typeof value === "string") {
    return requireValue(value, "url", "redis");
  }
  const reveal = (value as { readonly reveal?: unknown } | null)?.reveal;
  if (typeof reveal === "function") {
    return requireValue(reveal.call(value), "url", "redis");
  }
  throw new InfraError('Infra connector "redis": "url" must be a string or Secret.');
}

function withoutMode(cache: { readonly mode: "distributed" } & RedisDistributedCacheTuning): RedisDistributedCacheTuning {
  const { mode: _mode, ...tuning } = cache;
  return tuning;
}
