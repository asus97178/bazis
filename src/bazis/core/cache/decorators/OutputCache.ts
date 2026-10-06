import type { OutputCacheOptions } from "../types/CachePolicy";
import { ownOutputCacheActionMeta, ownOutputCacheMeta } from "./outputCacheMetadata";

type AnyClass = abstract new (...args: never[]) => unknown;
type AnyMethod = (...args: never[]) => unknown;
type ClassOrMethodDecorator = (
  value: AnyClass | AnyMethod,
  context: ClassDecoratorContext | ClassMethodDecoratorContext,
) => void;

/**
 * Server-side HTTP output cache for controller actions.
 *
 * Mirrors ASP.NET Core `[OutputCache]`. Requires a cache value
 * (`createApp({ cache: memory() })`); the output-cache middleware self-wires via DI.
 *
 * ```ts
 * @Get("products")
 * @OutputCache({ seconds: 60, varyByQuery: ["limit", "page"], tags: ["products"] })
 * list(limit = 20, page = 1) { ... }
 * ```
 */
export function OutputCache(options: OutputCacheOptions): ClassOrMethodDecorator {
  return (_value, context) => {
    if (context.kind === "class") {
      ownOutputCacheMeta(context.metadata).outputCache = options;
    } else {
      ownOutputCacheActionMeta(context.metadata, context.name).outputCache = options;
    }
  };
}

export type { OutputCacheOptions } from "../types/CachePolicy";
