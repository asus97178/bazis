import type { DistributedCacheStores } from "./DistributedCacheStores";
import type { DistributedCacheSetOptions, IDistributedCache } from "./IDistributedCache";

/**
 * The `IDistributedCache` of one connection that services inject by type:
 * values of `@CacheableRedis` and its own `get`/`getOrCreateAsync`; a tag is
 * evicted from those values and from the `@OutputRedisCache` responses of the
 * same connection, as `ICache.evictByTag` does in memory.
 */
export function connectionCache(stores: DistributedCacheStores, connection: string = stores.serviceCache.connectionNames[0]!): IDistributedCache {
  const values = stores.serviceCache.resolve(connection);
  const responses = stores.outputCache.resolve(connection);
  return Object.freeze({
    connectionName: values.connectionName,
    keyPrefix: values.keyPrefix,
    get: <T>(key: string) => values.get<T>(key),
    getOrCreateAsync: <T>(key: string, factory: () => Promise<T | undefined>, options: DistributedCacheSetOptions) => values.getOrCreateAsync<T>(key, factory, options),
    remove: (key: string) => values.remove(key),
    async evictByTag(tag: string): Promise<number> {
      const [fromValues, fromResponses] = await Promise.all([values.evictByTag(tag), responses.evictByTag(tag)]);
      return fromValues + fromResponses;
    },
  });
}
