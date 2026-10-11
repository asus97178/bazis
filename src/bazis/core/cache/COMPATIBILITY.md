# Cache Compatibility

The names below were removed; use the replacement. The `cached*` helpers were
public until 0.98.34, the others were removed in 0.96.1 before the first npm release.

| Removed name | Kind | Replacement |
| --- | --- | --- |
| `autoCachedScoped`, `cachedScoped` | public helpers, removed in 0.98.34 | `scoped(...)`: the cache hook wraps it |
| `autoCachedSingleton`, `cachedSingleton` | public helpers, removed in 0.98.34 | `singleton(...)` |
| `warnInsecureOutputCacheRoute` | public alias | `guardInsecureOutputCacheRoute` |
| `warnOnAuthorizedRoutesWithoutVaryByUser` | config switch | `insecureAuthorizedRouteBehavior` (`false` was `"ignore"`) |
| `DEFAULT_CACHEABLE_METHODS` | internal alias | `DEFAULT_OUTPUT_CACHE_METHODS` |
| `DEFAULT_CACHEABLE_STATUS_CODES` | internal alias | `DEFAULT_OUTPUT_CACHE_STATUS_CODES` |
