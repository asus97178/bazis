# Cache

Passport version: 1.4. Check date: 2026-10-04.
Status: implemented in the stated scope; check results are recorded in the fixes report.
Type: atomic technical module.
Path: `src/bazis/core/cache`.
Connection point: `memory(options)`; the advanced connection is `buildCacheModule(config)`.
Passport scope: MemoryCache, the DI method wrappers and the distributed backend composition.
The HTTP output cache and the distributed backend protocol are described in [SPEC.md](SPEC.md);
full physical Redis qualification is outside this passport.
Scaffold creation: existed before mandatory CLI generation; no new modules were created.

## 1. Responsibility and structure

The module stores and reuses results, coalesces concurrent requests for one key and
manages TTL, LRU and invalidation. MemoryCache owns the values, the tag index and
the accounting of unfinished factories. No submodules are used: it implements one
technical feature. Connecting concrete external clients belongs to Infra; the domain
correctness of a key belongs to the application.

The existing DI creates the cached class. Cache hooks into `ClassProvider.activation`
and wraps the ready instance. This keeps late codegen, static metadata, explicit deps,
the arity check, async resolve, lifetime and ownership.

Since 2026-10-02 (D1) `memory()`/`buildCacheModule()` only return a description.
A regular singleton value provider `CLASS_PROVIDER_HOOK` enables the wrappers when
the container that imports Cache is built; extracting `cache.providers` for
ServiceCollection is supported too. Other containers get no new dependencies or
wrappers. The declaration order of modules and `memory()` calls does not affect
independent compositions. This clarifies who owns the setting; the options
signatures and Cache operations are kept.

Implicit keys from arguments are isolated by the instance UUID for both scoped and
singleton. Two registrations of one class, equal token names and different DI
containers do not share values by accident. An explicit `key` keeps the separation
by class/method name and enables sharing across instances, scopes and processes.
It must take into account the tenant, user, data version and configuration that
affect the result. Trade-off: automatic distributed keys are not reused after a
restart or across processes; that needs an explicit application key. No external
dependencies or runtime compiler were added.

Since 2026-10-04 an automatic key accepts primitives, regular arrays, a Date without
added properties, a plain object with the Object.prototype or null prototype, and
regular Map and Set without their own extra properties. Nested collections are
supported. Record field keys are sorted; the order of Map/Set elements is kept, as
are array holes, undefined, numeric special values and the null prototype. Collection
iterators are taken from the built-in prototypes.

One AutomaticCacheKey belongs to a service proxy. On every call it rebuilds the data
graph of all arguments: repeated references differ from equal copies. Object keys of
a Map and Set elements also get a stable identifier through this proxy's WeakMap;
this distinguishes `map.has(knownObject)` from looking up another object with equal
fields. The encoder's own UUID rules out identifier collisions between proxies even
with an explicitly shared cacheNamespace. The identifier is added to every
occurrence of the object in the graph, including earlier arguments. The content is
read again, so changing a key, a value, the composition or the order of a collection
changes the next cache key. The WeakMap does not retain user objects after their
other references are released.

Instances of user classes, subclasses of built-in types, accessors, symbol fields,
non-enumerable and extra properties of built-in objects, functions, symbols, cycles,
Proxy (including revoked) and an invalid Date automatically **bypass the cache**.
The method is called exactly once; argument getters and Proxy traps are not run
while the key is built. Unsupported arguments need no `key` setting and do not cause
an encoder error. Neither the memory backend nor the distributed registry/backend is
read for such a call. Errors of the method itself, of an explicit `key` and of the
backend in use stay visible; `unless` keeps its behavior.
A missing distributed backend is checked only if the call uses the cache.

Regular records and arrays stay data by value: the field order of a record, the
writable/configurable/frozen flags and the arbitrary external identity of their
nested objects are not modeled. The key reflects the state at entry and does not
freeze the arguments; the calling code must not change the data of an unfinished
operation. Hidden user state is not supported by this mechanism.
An explicit application `key` stays an optional setting for other equivalence
semantics and for sharing across instances/processes.

Walking a Map/Set and the reference graph is linear in the visited elements and the
data size; sorting the fields of each record costs an extra O(k log k). The temporary
graph takes O(n) memory. There are no new external dependencies and no runtime
compiler; the built-in node:util is used to detect a Proxy. Contract checks:
[cache.automatic-keys.test.ts](test/cache.automatic-keys.test.ts).

The method proxy reads and writes properties with the original instance as `this`.
Regular getters/setters with #private, non-cached methods and dispose keep their
receiver. There are no new DI registrations or entry points. Regressions of these
contracts: [cache.proxy-contracts.test.ts](test/cache.proxy-contracts.test.ts).

## 2. Components and connection

| Component | File | Responsibility |
| --- | --- | --- |
| MemoryCache | [MemoryCache.ts](MemoryCache.ts) | Values, TTL/LRU, tags, coalescing and the factory limit |
| CacheOptions | [types/CacheOptions.ts](types/CacheOptions.ts) | Inputs and the configuration check |
| cachedSingleton / cachedScoped | [providers/cachedProviders.ts](providers/cachedProviders.ts) | A class provider with a wrapper after DI activation |
| wrapCachedService | [services/cacheProxy.ts](services/cacheProxy.ts) | Keys and calls into the memory/distributed API |
| AutomaticCacheKey | [internal/AutomaticCacheKey.ts](internal/AutomaticCacheKey.ts) | The argument graph, identity of collection keys and the cache bypass decision |
| memory | [cacheModule.ts](cacheModule.ts) | Global connection of the existing module |

`memory()` exports the DI tokens `ICache`, `CACHE_OPTIONS`, `CACHE_POLICIES`.
MemoryCache and the policies are singletons. Method wrappers need `ICache` and
`CACHE_POLICIES`; the distributed registry is read from the existing
`DISTRIBUTED_SERVICE_CACHE` if it is connected. The TypeScript facade is [index.ts](index.ts).
There are no new HTTP/AI inputs, ORM models, UI, background tasks or migrations.

## 3. Changed inputs and behavior

| Field / operation | Type and default | Check / result |
| --- | --- | --- |
| `CacheOptions.maxInFlight` | Optional number; 1024 | A positive safe integer; null, NaN, Infinity, fractions and zero are invalid |
| `CacheOptions.maxEntries` | Optional positive integer; unlimited | Bounds the ready values, independently of maxInFlight |
| `getOrCreate(key, factory, options?)` | The existing signature | A hit and joining an already running factory work at the full limit |
| A new miss at the full limit | No queue and no retries | A synchronous `CacheCapacityError`; the new factory is not called |
| `getOrCreateAsync` | The existing Promise result | Input and admission errors may be thrown synchronously, as before; an async factory error rejects the Promise |

A slot is held until the factory actually finishes, including a synchronous nested
activation. Success, a synchronous error and a Promise rejection release the slot.
`clear`, `remove`, `evictByTag` and `dispose` stop coalescing with invalidated work and
forbid the stale write, but do not release the slot of a running factory.
There is no automatic cancellation of an arbitrary user Promise. If a factory never
finishes, its slot stays held; further growth in the number of factories is bounded.
Waiting in an unbounded queue and running around the cache are not added.

Admission accounting is O(1), and the number of concurrent factories is bounded by
maxInFlight. The snapshot data size also depends on the number of tags per operation.
The limit belongs to MemoryCache; the configuration and local in-flight accounting of
DistributedCache are not affected by this change.
The other inputs (TTL, key length, values and policies) stay as in SPEC.md.

## 4. Checks

### Distributed backend: uniqueness and ownership

The application's module graph allows one unkeyed `DISTRIBUTED_CACHE_BACKEND`
registration. Cache checks the final collection after all `configure/remove/replace`
through the existing DI contribution validator.
Two registrations, including a mix of Redis and explicitly registered stores, give a
`CacheError` before the factories are activated, even with `validateOnBuild: false`.
Importing one module again creates no second contribution. Independent containers are
checked separately; the rule does not change the regular last-wins of other DI tokens.
The low-level `ServiceCollection` does not build a module graph; this check applies to
`createContainer` and the kernels built on it.

`DistributedCacheStores` is a narrow contract: `connectionNames`, `outputCache`,
`serviceCache`, `ping()`. It does not own the connection. The DI token
`DISTRIBUTED_CACHE_BACKEND` has this type and the name `DistributedCacheStores` for
interface binding through codegen. Infra creates, connects and closes the Redis connection.
One built-in Redis backend holds one named connection; other Redis clients are
connected with separate tokens without `cache`.
A custom backend may provide several names itself through the existing registries;
there is no automatic merging of different backends.

By the owner's direct instruction of 2026-10-02 the compatibility layer was removed:
the `DistributedCacheBackend` type, the old file/export and the empty `start/stop` of
the Redis backend are gone. The `CacheModuleConfig.distributedCache` field was removed
together with its backend/lifecycle/health registrations. This is an agreed change of
the public API within Cache; no aliases or transitional wrappers were introduced.

Distributed stores are connected through Infra/DI. The connector registers
`DISTRIBUTED_CACHE_BACKEND`, `DISTRIBUTED_OUTPUT_CACHE` and
`DISTRIBUTED_SERVICE_CACHE`; Infra manages its resource and health. The built-in path is
`redisConnect(config, { cache: "distributed" })`. `buildCacheModule` configures the
memory cache, policies, the HTTP composer and `cache:memory`; it has no hosted services
of its own. A custom backend provides DistributedCacheStores and connects its resource
with its own InfraConnector. No new modules or factories were added.

Checks of the composition, both connection orders, configure, isolation and the single
resource owner: [cache-composition.test.ts](../infra/test/cache-composition.test.ts).
These are local scenarios with stub clients, without a Redis server.
The removal of the old inputs is checked by the [TypeScript contract](test/cache.contracts.typecheck.ts),
and running the current API in a binary by the [composition fixture](../infra/test/fixtures/cache-orm-composition.ts).
Results of the API removal: [audit addendum](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-design-2026-10-02/INFRA_CACHE_FIXES.md#удаление-слоя-совместимости-cache).

Regressions: [cache.architecture-regressions.test.ts](test/cache.architecture-regressions.test.ts),
[autoCachedProviders.test.ts](test/autoCachedProviders.test.ts), the existing cache tests.
They check DI.bindDeps/static/codegen/explicit deps, async dependencies, disposal,
singleton/keyed isolation, both backends through a stub driver, the limit and invalidation.
The standalone CLI/codegen/source/compiled runtime is checked in the
[integration check](../../cli/test/standalone-runtime.integration.test.ts).
Actual results and limits are in the
[fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-architecture-2026-10-02/FIXES.md).
