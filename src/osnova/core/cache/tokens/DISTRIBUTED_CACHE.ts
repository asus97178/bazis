import { createToken, registerModuleOwnedContributionValidator } from "../../di";
import { CacheError } from "../errors/CacheError";
import type { CachedHttpPayload } from "../http/CachedHttpPayload";
import type { DistributedCacheStores } from "../distributed/DistributedCacheStores";
import type { IDistributedCache } from "../distributed/IDistributedCache";
import type { NamedCacheRegistry } from "../distributed/NamedCacheRegistry";

/** One global backend per application; named connections belong to that backend. */
export const DISTRIBUTED_CACHE_BACKEND = createToken<DistributedCacheStores>("DistributedCacheStores");

registerModuleOwnedContributionValidator((snapshot) => {
  const count = snapshot.countProviders(DISTRIBUTED_CACHE_BACKEND);
  if (count > 1) {
    throw new CacheError(
      `Only one distributed cache backend may be registered per application; found ${count}. ` +
      'Enable cache: "distributed" on one Redis connector, or register one custom backend. ' +
      "Other Redis connectors may use distinct client tokens without cache mode.",
    );
  }
});

/** Named HTTP output payload stores (`@OutputRedisCache`). */
export const DISTRIBUTED_OUTPUT_CACHE = createToken<NamedCacheRegistry<IDistributedCache<CachedHttpPayload>>>(
  "DistributedOutputCacheRegistry",
);

/** Named service value stores (`@CacheableRedis`). */
export const DISTRIBUTED_SERVICE_CACHE = createToken<NamedCacheRegistry<IDistributedCache>>(
  "DistributedServiceCacheRegistry",
);
