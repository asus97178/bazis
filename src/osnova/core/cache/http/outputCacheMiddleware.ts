import type { HttpMiddleware } from "../../http";
import type { InjectionToken } from "../../di";
import { ICache } from "../ICache";
import {
  DEFAULT_OUTPUT_CACHE_METHODS,
  DEFAULT_OUTPUT_CACHE_STATUS_CODES,
  type ResolvedOutputCacheOptions,
} from "../internal/resolveCachePolicy";
import { canBuildPersonalizedOutputCacheKey, OUTPUT_CACHE_PRINCIPAL_STATE_KEY } from "./buildOutputCacheKey";
import { buildOutputCacheKey } from "./buildOutputCacheKey";
import { applyClientCacheHeaders, resolveOutputClientCacheOptions } from "./applyClientCacheHeaders";
import {
  cachedPayloadToResponse,
  resolveCachedHttpPayloadReadOptions,
  responseAllowsServerCache,
  responseToCachedPayload,
  type CachedHttpPayload,
} from "./CachedHttpPayload";

export interface OutputCacheMiddlewareOptions {
  readonly cacheToken?: InjectionToken<ICache<CachedHttpPayload>>;
  readonly routeName: string;
  readonly config: ResolvedOutputCacheOptions;
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

/** Per-route output cache middleware compiled from `@OutputCache` metadata. */
export function outputCacheMiddleware(options: OutputCacheMiddlewareOptions): HttpMiddleware {
  const { routeName, config } = options;
  const cacheToken = options.cacheToken ?? (ICache as InjectionToken<ICache<CachedHttpPayload>>);
  const payloadReadOptions = resolveCachedHttpPayloadReadOptions(config);
  const clientCache = resolveOutputClientCacheOptions(config);

  return async (ctx, next) => {
    const cache = ctx.services.resolve(cacheToken);
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
      // Never add a public/shared-cache directive to a personalized response.
      // The action may still provide its own deliberate Cache-Control policy.
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

    const key = buildOutputCacheKey(ctx, routeName, config);
    const cached = cache.get(key);
    if (cached !== undefined) {
      ctx.response = applyClientCacheHeaders(cachedPayloadToResponse(cached), clientCache);
      return;
    }

    const setOptions = { ttlSeconds: config.seconds, tags: config.tags };
    const payload = await cache.getOrCreateAsync(key, async () => {
      await next();
      if (
        ctx.response === undefined
        || !allowsStatus(ctx.response.status, config.statusCodes)
        || !responseAllowsServerCache(ctx.response, config.varyByHeader)
      ) {
        return undefined;
      }
      return responseToCachedPayload(ctx.response, payloadReadOptions);
    }, setOptions);

    if (payload !== undefined) {
      ctx.response = applyClientCacheHeaders(cachedPayloadToResponse(payload), clientCache);
      return;
    }

    // Анти-stampede мог склеить наш запрос с другим, чей ответ оказался
    // некэшируемым: тогда фабрика отработала на чужом контексте и наш `ctx.response`
    // пуст — выполняем конвейер сами, чтобы вернуть полноценный ответ.
    if (ctx.response === undefined) {
      await next();
    }
  };
}
