import type { HttpMiddleware } from "../../http";
import { CacheError } from "../errors/CacheError";
import { DISTRIBUTED_OUTPUT_CACHE } from "../tokens/DISTRIBUTED_CACHE";
import {
  DEFAULT_OUTPUT_CACHE_METHODS,
  DEFAULT_OUTPUT_CACHE_STATUS_CODES,
} from "../internal/resolveCachePolicy";
import type { ResolvedOutputRedisCacheOptions } from "../types/OutputRedisCacheOptions";
import { canBuildPersonalizedOutputCacheKey, OUTPUT_CACHE_PRINCIPAL_STATE_KEY } from "./buildOutputCacheKey";
import { buildRedisOutputCacheKey } from "./buildRedisOutputCacheKey";
import { applyClientCacheHeaders, resolveOutputClientCacheOptions } from "./applyClientCacheHeaders";
import {
  cachedPayloadToResponse,
  resolveCachedHttpPayloadReadOptions,
  responseAllowsServerCache,
  responseToCachedPayload,
} from "./CachedHttpPayload";

export interface OutputRedisCacheMiddlewareOptions {
  readonly routeName: string;
  readonly config: ResolvedOutputRedisCacheOptions;
}

function isAuthenticated(ctx: Parameters<HttpMiddleware>[0]): boolean {
  return ctx.state.get(OUTPUT_CACHE_PRINCIPAL_STATE_KEY) !== undefined;
}

function allowsMethod(method: string, allowed: readonly string[] | undefined): boolean {
  const methods = allowed ?? DEFAULT_OUTPUT_CACHE_METHODS;
  return methods.includes(method.toUpperCase());
}

function allowsStatus(status: number, allowed: readonly number[] | undefined): boolean {
  const codes = allowed ?? DEFAULT_OUTPUT_CACHE_STATUS_CODES;
  return codes.includes(status);
}

/** Per-route Redis output cache middleware compiled from `@OutputRedisCache` metadata. */
export function outputRedisCacheMiddleware(options: OutputRedisCacheMiddlewareOptions): HttpMiddleware {
  const { routeName, config } = options;
  const payloadReadOptions = resolveCachedHttpPayloadReadOptions(config);
  const clientCache = resolveOutputClientCacheOptions(config);

  return async (ctx, next) => {
    const registry = ctx.services.tryResolve(DISTRIBUTED_OUTPUT_CACHE);
    if (registry === undefined) {
      throw new CacheError(
        `@OutputRedisCache on ${routeName} requires a distributed cache backend — `
          + 'add redisConnect(redisConfig, { cache: "distributed" }) to your @Infra manifest',
      );
    }
    const cache = registry.resolve(config.connection);

    if (config.enabled === false || config.noStore === true) {
      await next();
      return;
    }

    if (!allowsMethod(ctx.method, config.methods)) {
      await next();
      return;
    }

    if (config.unlessAuthenticated === true && isAuthenticated(ctx)) {
      await next();
      // Do not mark personalized bypass responses as public cacheable.
      return;
    }

    if (!canBuildPersonalizedOutputCacheKey(ctx, config)) {
      await next();
      return;
    }

    if (config.when !== undefined) {
      const allowed = await config.when(ctx);
      if (!allowed) {
        await next();
        return;
      }
    }

    const key = buildRedisOutputCacheKey(ctx, routeName, config);
    const cached = await cache.get(key);
    if (cached !== undefined) {
      ctx.response = applyClientCacheHeaders(cachedPayloadToResponse(cached), clientCache);
      return;
    }

    const payload = await cache.getOrCreateAsync(
      key,
      async () => {
        await next();
        if (
          ctx.response === undefined
          || !allowsStatus(ctx.response.status, config.statusCodes)
          || !responseAllowsServerCache(ctx.response, config.varyByHeader)
        ) {
          return undefined;
        }
        return responseToCachedPayload(ctx.response, payloadReadOptions);
      },
      { ttlSeconds: config.seconds, tags: config.tags, lockSeconds: config.lockSeconds },
    );

    if (payload !== undefined) {
      ctx.response = applyClientCacheHeaders(cachedPayloadToResponse(payload), clientCache);
      return;
    }

    // Anti-stampede may have merged our request with another one whose response turned out
    // uncacheable: then the factory ran on the other context and our `ctx.response`
    // is empty, so run the pipeline ourselves to return a complete response.
    if (ctx.response === undefined) {
      await next();
    }
  };
}
