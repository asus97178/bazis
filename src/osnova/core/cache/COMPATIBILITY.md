# Cache Compatibility

Compatibility names are kept only when removing them would break existing app
code. They are not the preferred DX for new code.

| Name | Classification | Replacement | Window |
| --- | --- | --- | --- |
| `cachedScoped` | canonical | — | keep |
| `cachedSingleton` | canonical | — | keep |
| `autoCachedScoped` | deprecated public alias | `cachedScoped` | keep through 0.x; earliest removal 1.0 |
| `autoCachedSingleton` | deprecated public alias | `cachedSingleton` | keep through 0.x; earliest removal 1.0 |
| `warnOnAuthorizedRoutesWithoutVaryByUser` | deprecated config switch | `insecureAuthorizedRouteBehavior` | keep through 0.x; earliest removal 1.0 |
| `DEFAULT_CACHEABLE_METHODS` | deprecated internal alias | `DEFAULT_OUTPUT_CACHE_METHODS` | keep through 0.x; earliest removal 1.0 |
| `DEFAULT_CACHEABLE_STATUS_CODES` | deprecated internal alias | `DEFAULT_OUTPUT_CACHE_STATUS_CODES` | keep through 0.x; earliest removal 1.0 |

New code should use the canonical names. Compatibility aliases must stay as
identity aliases until their documented removal window closes.
