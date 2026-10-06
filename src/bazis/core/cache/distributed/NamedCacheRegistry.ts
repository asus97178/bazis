import { CacheError } from "../errors/CacheError";
import { DEFAULT_CACHE_CONNECTION } from "./IDistributedCache";

/** Resolves named distributed-cache connections registered by a backend. */
export class NamedCacheRegistry<TCache> {
  public constructor(
    private readonly entries: ReadonlyMap<string, TCache>,
    private readonly kind = "distributed cache",
  ) {}

  public resolve(name: string = DEFAULT_CACHE_CONNECTION): TCache {
    const found = this.entries.get(name);
    if (found === undefined) {
      const available = [...this.entries.keys()].join(", ") || "(none)";
      throw new CacheError(`Unknown ${this.kind} connection "${name}". Available: ${available}`);
    }
    return found;
  }

  public get connectionNames(): readonly string[] {
    return [...this.entries.keys()];
  }
}
