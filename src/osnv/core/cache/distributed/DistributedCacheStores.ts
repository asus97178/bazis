import type { CachedHttpPayload } from "../http/CachedHttpPayload";
import type { IDistributedCache } from "./IDistributedCache";
import type { NamedCacheRegistry } from "./NamedCacheRegistry";

/** Per-connection health probe result. */
export interface DistributedCachePing {
  readonly connection: string;
  readonly healthy: boolean;
  readonly detail?: string;
}

/**
 * Stores and health supplied by one distributed backend. Resource ownership is
 * separate: the Infra connector manages the connection.
 */
export interface DistributedCacheStores {
  /** Configured connection names. */
  readonly connectionNames: readonly string[];

  /** HTTP output payload stores per connection. */
  readonly outputCache: NamedCacheRegistry<IDistributedCache<CachedHttpPayload>>;

  /** Service value stores per connection. */
  readonly serviceCache: NamedCacheRegistry<IDistributedCache>;

  /** Liveness probe for each connection. */
  ping(): Promise<readonly DistributedCachePing[]>;
}
