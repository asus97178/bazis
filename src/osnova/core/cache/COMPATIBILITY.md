# Cache Compatibility

The aliases below were removed in 0.96.1, before the first `osnv` npm release,
so no published version ever contained them. Use the replacement.

| Removed name | Kind | Replacement |
| --- | --- | --- |
| `autoCachedScoped` | public alias | `cachedScoped` |
| `autoCachedSingleton` | public alias | `cachedSingleton` |
| `warnInsecureOutputCacheRoute` | public alias | `guardInsecureOutputCacheRoute` |
| `warnOnAuthorizedRoutesWithoutVaryByUser` | config switch | `insecureAuthorizedRouteBehavior` (`false` was `"ignore"`) |
| `DEFAULT_CACHEABLE_METHODS` | internal alias | `DEFAULT_OUTPUT_CACHE_METHODS` |
| `DEFAULT_CACHEABLE_STATUS_CODES` | internal alias | `DEFAULT_OUTPUT_CACHE_STATUS_CODES` |
