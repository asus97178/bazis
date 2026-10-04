// Распределённый кэш-бэкенд поверх Redis. Реализует абстракции `@/core/cache`
// (DistributedCacheDriver/Backend), поэтому ядро кэша остаётся backend-agnostic.
export {
  RedisDistributedCacheBackend,
  type RedisDistributedCacheTuning,
} from "./RedisDistributedCacheBackend";
export { RedisDistributedCacheDriver, type RedisCommandClient } from "./RedisDistributedCacheDriver";
