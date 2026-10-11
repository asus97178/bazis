import type { CacheableRedisOptions } from "../types/CacheableRedisOptions";
import { ownCacheableRedisMeta, ownCacheableRedisMethodMeta } from "./cacheableRedisMetadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type ClassOrMethodDecorator = (
  value: AnyClass | AnyMethod,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Shared service method cache backed by the distributed tier (multi-instance safe).
 *
 * Requires a distributed backend: add `redisConnect(redisConfig, { cache: "distributed" })`
 * to your `@Infra` manifest. Register the class as usual (`scoped` / `singleton`):
 * the cache module wraps it. Values must be plain JSON.
 *
 * ```ts
 * class UserService implements IUserStore {
 *   @CacheableRedis({ seconds: 300, key: (id) => `user:${id}`, tags: ["users"] })
 *   async byId(id: number) { ... }
 * }
 *
 * scoped(IUserStore, UserService);
 * ```
 */
export function CacheableRedis(options: CacheableRedisOptions): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownCacheableRedisMeta(context.metadata).cacheableRedis = options;
    } else {
      const methodMeta = ownCacheableRedisMethodMeta(context.metadata, context.name);
      Object.assign(methodMeta, options);
    }
  };
}

export type { CacheableRedisOptions } from "../types/CacheableRedisOptions";
