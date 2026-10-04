import type { DistributedCacheStores } from "../index";
import type { CacheModuleConfig } from "../internal/buildCacheProviders";
import type { RedisDistributedCacheBackend } from "../../infra";

// @ts-expect-error The combined stores + HostedService interface was removed.
import type { DistributedCacheBackend } from "../index";

type Assert<T extends true> = T;
type HasNoLifecycle<T> = Extract<"start" | "stop", keyof T> extends never ? true : false;

type StoresHaveNoLifecycle = Assert<HasNoLifecycle<DistributedCacheStores>>;
type RedisHasNoLifecycle = Assert<HasNoLifecycle<RedisDistributedCacheBackend>>;
type CacheHasNoBackendOption = Assert<"distributedCache" extends keyof CacheModuleConfig ? false : true>;
