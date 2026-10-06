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

/** Redis/Valkey client (native Bun `RedisClient`, no external dependencies). */
export const REDIS: InjectionToken<RedisClient> = createToken<RedisClient>("Redis");

/**
 * Config interface required by the Redis connector. The subsystem config
 * (`defineConfig<RedisConfig>("redis", ...)`) must provide these keys.
 */
export interface RedisConfigShape {
  /** Full connection string, e.g. `redis://localhost:6379`. */
  readonly url: string | Secret;
}

export type RedisConnectorCacheMode =
  | "distributed"
  | ({ readonly mode: "distributed" } & RedisDistributedCacheTuning);

export interface RedisConnectorOptions {
  readonly token?: InjectionToken<RedisClient>;
  /**
   * Publishes a distributed cache backend on top of the client: `{ cache: "distributed" }`.
   * For fine tuning use `{ cache: { mode: "distributed", keyPrefix, ... } }`.
   * An application may have one backend; a second one is rejected when the container is built.
   */
  readonly cache?: RedisConnectorCacheMode;
}

/**
 * Distributed cache providers on top of the Redis client: the backend plus two
 * registries (HTTP responses and method values). The cache module picks them up from DI.
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
 * Redis connector for the `@Infra` manifest. Configuration comes from the given
 * `redisConfig` (`defineConfig("redis", ...)`): the connector reads the declared
 * `url` key. Opens the connection at start and closes it at shutdown. The second
 * argument takes connector options (distributed cache and so on).
 *
 * ```ts
 * export const redisConfig = defineConfig("redis", { default: { url: "redis://localhost:6379" } });
 * @Infra({ cache: redisConnect(redisConfig, { cache: "distributed" }) })
 * export class AppInfra {}
 * // injection by token: scoped(ISessionsService, SessionsService, [REDIS] as const)
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
