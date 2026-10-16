import { RedisClient } from "bun";
import {
  DISTRIBUTED_CACHE_BACKEND,
  DISTRIBUTED_OUTPUT_CACHE,
  DISTRIBUTED_SERVICE_CACHE,
  IDistributedCache,
  connectionCache,
  type DistributedCacheStores,
} from "../../cache";
import { createToken, DI, type InjectionToken, type ProviderDefinition } from "../../di";
import type { AppConfig, Secret } from "../../kernel";
import { RedisDistributedCacheBackend, type RedisDistributedCacheTuning } from "../cache/RedisDistributedCacheBackend";
import { reader, requireValue, settingNames } from "../connectorConfig";
import { errorMessage, InfraError, type InfraConnector } from "../InfraConnector";
import { redactSensitiveText } from "../../../library/redaction";
import { identifyConnector } from "../connectorIdentity";

const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Redis/Valkey client (native Bun `RedisClient`, no external dependencies) of
 * the `redisConnect()` connector, injected by type:
 * `constructor(private readonly redis: IRedis)`.
 */
export interface IRedis extends RedisClient {}
export const IRedis = createToken<IRedis>("IRedis") as InjectionToken<RedisClient>;

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
   * How long the start waits for the first connection, ms (default 5000).
   * The Bun client keeps retrying a refused connection; without a bound an
   * unreachable Redis held the whole start until its timeout.
   */
  readonly connectTimeoutMs?: number;
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
    // This connector's one connection by type, for services that evict tags or
    // read values; its name may be "default" or the configured `connection`.
    DI.singleton(
      DI.factoryProvider(IDistributedCache, [DISTRIBUTED_CACHE_BACKEND], (backend: DistributedCacheStores) => connectionCache(backend)),
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
 * // by type: class SessionsService { constructor(private readonly redis: IRedis) {} }
 * ```
 */
export function redisConnect<T extends RedisConfigShape>(
  config: AppConfig<T>,
  options: RedisConnectorOptions = {},
): InfraConnector<RedisClient> {
  const cache = options.cache;
  const token = options.token ?? IRedis;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_REDIS_CONNECT_TIMEOUT_MS;
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new InfraError("redisConnect connectTimeoutMs must be a positive integer.");
  }
  const urls = new WeakMap<RedisClient, string>();
  const settings = new WeakMap<RedisClient, string[]>();
  const cacheProviders =
    cache === undefined
      ? undefined
      : distributedCacheProviders(cache === "distributed" ? {} : withoutMode(cache), token);

  return identifyConnector({
    token,
    config,
    providers: cacheProviders,
    exports: cacheProviders ? [DISTRIBUTED_CACHE_BACKEND, DISTRIBUTED_OUTPUT_CACHE, DISTRIBUTED_SERVICE_CACHE, IDistributedCache] : undefined,
    create(configs) {
      const url = redisUrl(reader(config, configs).get("url"));
      const client = new RedisClient(url);
      urls.set(client, url);
      settings.set(client, settingNames(config, configs, ["url"]));
      return client;
    },
    async describe(client, { connected }) {
      const info = connected ? String(await client.send("INFO", ["server"])) : "";
      const valkey = /valkey_version:([^\r\n]+)/.exec(info)?.[1];
      const redis = /redis_version:([^\r\n]+)/.exec(info)?.[1];
      return {
        kind: valkey ? `Valkey ${valkey}` : redis ? `Redis ${redis}` : "Redis",
        address: redisAddress(urls.get(client) ?? ""),
        settings: settings.get(client) ?? [],
      };
    },
    async connect(client) {
      // The address without a password: it names the server in the error.
      const target = redactSensitiveText(urls.get(client) ?? "redis");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new InfraError(`Infra connector "redis": failed to connect to ${target} within ${connectTimeoutMs} ms.`)), connectTimeoutMs);
      });
      try {
        await Promise.race([client.connect(), deadline]);
      } catch (error) {
        if (error instanceof InfraError) {
          client.close();
          throw error;
        }
        throw new InfraError(`Infra connector "redis": failed to connect to ${target} — ${errorMessage(error)}`);
      } finally {
        clearTimeout(timer);
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
  }, "redis");
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

/** `127.0.0.1:6379/0` without the scheme, user and password. */
function redisAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "6379"}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return redactSensitiveText(url);
  }
}
