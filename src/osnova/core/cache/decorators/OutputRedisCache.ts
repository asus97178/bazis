import type { OutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";
import { ownOutputRedisCacheActionMeta, ownOutputRedisCacheMeta } from "./outputRedisCacheMetadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type ClassOrMethodDecorator = (
  value: AnyClass | AnyMethod,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Shared HTTP output cache backed by the distributed tier (multi-instance safe).
 *
 * Requires a distributed backend: add `redisConnect(redisConfig, { cache: "distributed" })`
 * to your `@Infra` manifest.
 *
 * ```ts
 * @Get("products")
 * @OutputRedisCache({ seconds: 60, varyByQuery: ["limit", "page"], tags: ["products"] })
 * list() { ... }
 * ```
 */
export function OutputRedisCache(options: OutputRedisCacheOptions): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownOutputRedisCacheMeta(context.metadata).outputRedisCache = options;
    } else {
      ownOutputRedisCacheActionMeta(context.metadata, context.name).outputRedisCache = options;
    }
  };
}

export type { OutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";
