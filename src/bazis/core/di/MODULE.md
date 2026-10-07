# DI: the container core

Passport version: 1.6. Check date: 2026-10-04.
Status: implemented; checks and limits are listed in §6.
Type: atomic technical module.
Path: `src/bazis/core/di`.
Connection points: `ServiceCollection.buildServiceProvider()` and `createContainer()`.
Passport scope: registration, dependency resolution, activations, scopes and resource
release, module extensions and Options/Application; the public signatures are in
[index.ts](index.ts) and the `provider/`, `module/` types.
Scaffold creation: existed before mandatory CLI generation. This refactoring added
internal classes of the existing DI; no new architectural modules or `@Module`
declarations were created.

## 1. Responsibility and decision

The container creates objects from registrations, keeps their identity per lifetime,
detects invalid dependencies and releases the resources it owns. It is one technical
feature; the separate internal algorithms need no submodules or extra DI containers.

Decision of 2026-09-19: split the state and duties of `ServiceProvider` by composing
three internal classes. `ServiceProvider` itself coordinates sync/async resolve,
building dependency plans and creating classes/factories/Lazy. The creation algorithms
and their shared context stay together, so the split needs no mutual references or a
pile of callback interfaces.

| Owner | State and invariants | Contract inside DI |
| --- | --- | --- |
| [ServiceRegistry](internal/ServiceRegistry.ts) | Registrations, identity, the name index, key lookups, atomic generic materialization; an explicit closed registration wins | `find`, `all`, `groups`, `lookupName`, `validateOpenGenerics` |
| [ResolutionTracker](internal/ResolutionTracker.ts) | Identity of active creations, their entry/exit, wait links, captured chains; a finished activation is not retained | `create`, `enter`, `leave`, `assertNoCycle`, `capture`, `join`, `addWait`, `removeWait` |
| [ScopeLifecycle](internal/ScopeLifecycle.ts) | Root/child scopes, resource identity and shared dispose completion; a resource is released once | `createScope`, `targetFor`, `assertLive`, `track`, `dispose`, `disposeScope` |
| [GraphValidator](internal/GraphValidator.ts) | The graph check at build time through the narrow `GraphValidationContext` | `validate` |
| [ServiceProvider](ServiceProvider.ts) | Resolving and creating dependencies; the cache of normalized plans | The existing `ServiceResolver` and scope management |

`ResolutionScopeState` stays the internal scope context. The tracker changes its
accounting of activations/waits, the resolver the cache and unfinished creations, and
the lifecycle closes and clears the context after they finish. The wait and cleanup
operations keep their order; no public access to these tables is added.

The three extra objects are created once per container. No new interfaces for
alternative implementations, inheritance hierarchies or external dependencies are
needed. Measurements of the relevant scenario are in §6.

The optimization of 2026-09-19 stays inside `ServiceRegistry`: successful registration
lookups are reused. For a single resolution, lists of up to eight registrations are
checked directly; in a long list the last explicit registration is also returned
directly on a key match. Other successful lookups in long lists are cached. `all`
reuses the lookup for several registrations; the single-registration case skips the cache.

The caches are created on first use, belong to one registry and hold registration
metadata. Service instances and scopes are still managed by the resolver/lifecycle.
Unknown keys are not written into the new caches; the number of records and of
references to registrations is bounded by O(N), where N is the number of the
container's registrations. After generic registrations are published successfully,
the lookups of the changed group are reset. A materialization error does not publish
a partial group.

Trade-off: a little extra state to avoid repeated passes and filtering. The direct
lookup threshold was chosen by measurement: for eight keys the extra `WeakMap`/`Map`
accesses cost more than a pass. Public contracts, the order and priority of
registrations, visibility checks and lifetime stay the same.

## 2. Connection and boundaries

The public TypeScript entry is [index.ts](index.ts); its exports are kept.
The new classes are available only from `internal/` and are not exported by the DI
facade. The container creates them itself; they are not registered as application
services and need no codegen. The constructors of registered services and the
generated deps did not change. The usual connection of application classes through
constructor DI and `scoped`/`singleton`/`transient` is kept.

`ServiceScope` delegates operations through the existing narrow `ScopeResolver`.
`DiContainer` still extends `ServiceProvider`; module composition, registration
order, `imports/exports` and the extension connection points are kept.
HTTP, ORM, AI, kernel configuration and external connections are not the
responsibility of these internal classes.

Fixes from the architecture audit of 2026-10-02:

- Generated dependencies are bound to the concrete constructor. Matching by a single
  class name from the package `generated/deps.ts` is no longer used.
  Codegen passes exported dependency classes (and Lazy) as exact tokens that survive
  renaming by the bundler; interfaces/IRepository stay named.
  The generated runtime still accepts the older string descriptors.
  The application activates its own generated runtime before the container is built.
  Priority: explicit `provider.deps`, then `DI.bindDeps` / static metadata, then
  codegen. `[]` stays an explicit value. Shortcuts do not fix inferred deps when the
  module is declared, so a late bootstrap is kept.
- A cycle of `imports`, including contributions of module expanders, stops the build
  with `ModuleEncapsulationError` and the module chain. Repeated imports and diamonds are allowed.
- In a graph with closed modules the owner of the registration actually chosen for a
  token/key is checked, including open generics. An invisible last registration raises
  `ModuleEncapsulationError` even if the token is visible from another owner.
  This is a rejection of an ambiguous composition; no local DI containers were added.
  Visible overrides and the root `resolveAll` keep the former order. Factories with a
  manual `resolver.resolve` must respect the boundaries: their dynamic requests do not
  turn into static dependencies automatically.

The extra selection check runs at build time and on generic materialization, not on
every resolve. For `configure()` the identity of the added registrations is taken into
account, because replace/remove change the collection indexes.

Constructor codegen clarification of 2026-10-04: a class without its own constructor
gets the dependencies of the effective base constructor, including substituted generic
parameters and `Lazy<T>`. The binding belongs to the exact subclass; dependencies with
the same name and export aliases/default are not mixed. An own constructor, including
an empty one, sets its own list; the priority of explicit provider deps,
`DI.bindDeps`/`DI.injectFor` and static metadata is kept. Optional trailing parameters
stay outside the automatic list.
If a required inherited parameter has no runtime token that can be inferred, a regular
DI registration without explicit metadata gets `BAZIS_DI_CONSTRUCTOR_UNRESOLVED`;
the subclass's zero JS arity is not presented as having no dependencies. Generic bases
and helpers that are never registered are not limited by this diagnostic.

Non-exported local helpers get no generated imports. When such a class is used in a
regular DI registration that needs inferred constructor deps, codegen ends with
`BAZIS_DI_CLASS_UNIMPORTABLE` before writing results and names the class/file. Exporting
the class, including under an alias, gives the usual automatic binding; no manual deps
are needed for it. Already explicitly configured private providers keep their behavior.
The regression [di-inherited-constructor.integration.test.ts](../scripts/test/di-inherited-constructor.integration.test.ts)
runs real isolated codegen, typing, the sources and a compiled binary.

## 3. Data and lifetime

### Checking the final registrations of the module graph

Contribution validators get a `ModuleOwnedValidationSnapshot` that extends the former
`ModuleOwnedContributionSnapshot` with the `countProviders(token, key?)` method.
The token is required; a missing key means only unkeyed registrations, an explicit key
is compared by the existing DI rules. The result is the number of registrations after
`configure/remove/replace` and the normalization of class providers. Factories are not
called; services and the mutable collection are not exposed. A validator error aborts
the build before activations regardless of `validateOnBuild`. Older validators that
take the regular contribution snapshot stay compatible.

Cache uses this input to forbid a second global backend. DI does not import Cache and
sets no special semantics for its tokens. The count is linear in the number of
registrations and runs at build time; the resolve path does not change. The simplified
ServiceCollection does not run module validators, as before.

### Class extensions at build time (D1, 2026-10-02)

`CLASS_PROVIDER_HOOK` takes an unkeyed singleton value provider with a
`ClassProviderHook` value. The function input: provide, useClass, lifetime, deps; the
result is a ProviderDefinition or undefined. Null, factory, scoped/transient and keyed
hook registrations are rejected with TypeError before factories run.
The functions are collected from the providers actually connected and deduplicated by
identity. The first matching hook keeps the former semantics; a ready activation is not
wrapped again. Cache uses this input without a process-wide switch.
Hooks apply after configure to the collection snapshot, before the visibility/deps
checks; open generics go through the same transformation before publication. The
original definitions do not change. A direct ServiceCollection supports the same contract.
The process-wide `registerClassProviderHook` was removed in 0.96.1: nobody called it,
and hooks are set only by a value provider in their container. The work runs at
build/materialization time; there are no extra checks on each resolve.
Checks: `cache.container-isolation.test.ts`, the existing DI/cache regressions.

The state is kept in the memory of one container and its scopes; the DI core has no
persistent storage, migrations, network calls or environment of its own.
The semantics of `singleton`, `scoped`, `transient`, `useValue` and
`ownership: "external"` are kept. Values passed from outside and the container itself
are not added to the list of disposable objects owned by DI.

The start of dispose closes the scope for new resolutions at once. All calls join the
existing completion work; cleanup waits for async creations already started.
A resource created late is released, and the resolve waiting for it gets
`ScopeDisposedError`. Disposer errors do not stop the cleanup of other resources;
several errors are returned as `AggregateError`.

No automatic cancellation of a user factory and no deadline are added: a factory that
never finishes may hold up a dispose waiting for it.

## 4. Kept inputs

The registration fields and dependency descriptors are defined in
[ProviderDefinition](provider/types/ProviderDefinition.ts),
[Provider](provider/types/Provider.ts) and [token.ts](token.ts).
The inputs of the affected core are recorded here; the optional
`ClassProvider.activation` extension after the architecture audit is described in §5.

| Field | Type | Required / default | Meaning and check |
| --- | --- | --- | --- |
| constructor `definitions` | `readonly ProviderDefinition[]` | Required; an empty array is allowed | Registrations with `provider`, `lifetime`, an optional `key`; the order matters |
| constructor `openGenericRegistrations` | `readonly OpenGenericRegistration[]` | Required; an empty array is allowed | A family, factory, lifetime and an optional key |
| `options.validateOnBuild` | `boolean` | Optional; `false` | Checks the existence of dependencies, cycles, lifetime and arity at build time |
| `options.validateScopes` | `boolean` | Optional; `true` | Forbids scoped from the root or a singleton chain |
| `token` of resolve/has/tryResolve | `Token<T>` | Required | A class, an abstract class (a service contract, since 0.97.0) or an injection token; identity selects the registration |
| `key` of keyed methods | `string \| number \| symbol` | Required for keyed; `undefined` for a regular resolve/optional tryResolve | Selects the registration with this key |
| `scopeState` of the `*ForScope` methods | `ResolutionScopeState` | Passed by `ServiceScope` | The internal context kept until the scope's work finishes |

`null` is not part of these field types; this refactoring introduces no JSON binding
and no extra runtime schema. The behavior on invalid JavaScript input is not extended.

| Operations | Result | Errors and effects |
| --- | --- | --- |
| `resolve`, `resolveKeyed`, the matching `*ForScope` | `T` | Creation/reuse; the missing/cycle/lifetime/disposed/async-required errors are kept |
| `resolveAsync`, `resolveKeyedAsync`, `resolveAsyncForScope` | `Promise<T>` | Waits for async factories, merges repeated cached-lifetime requests; factory and cycle errors propagate |
| `resolveAll`, `resolveAllKeyed`, the matching `*ForScope` | `readonly T[]` | All matching registrations in the former order, an empty array when there are none; another key does not get into the current selection on a nested resolve |
| `tryResolve`, `tryResolveForScope` | `T \| undefined` | Only a missing registration gives `undefined`; other errors propagate |
| `has` | `boolean` | Checks for a registration; keeps the ability to materialize a closed generic |
| `createScope()` | `ServiceScope` | No arguments; creates a scope owned by the container |
| `dispose()`, `disposeScope(scopeState)` | `Promise<void>` | Releases resources; the public dispose takes no manual arguments |

## 5. Substitution and extension

The [module contributions](module/moduleOwnedProviderContributors.ts) context got
`registerScoped(channel, definition, payload)`. All three arguments are required: the
provider channel, an unkeyed scoped self-class ProviderDefinition and the consumer
metadata. The result is a ModuleOwnedProviderActivation for the exact registration.
Without an own provider it adds the passed regular registration; with one it calls the
existing attachExistingScoped. An incompatible registration is not replaced;
lifetime/type/duplicate give a build error. The lifetime stays scoped; module
ownership, constructor DI/codegen and encapsulation are checked as usual.
The addition happens only in the open owner window of the container build, not on
resolve. attachExistingScoped keeps its strict former "missing" semantics.
addScoped with a private key for hooks does not change either. The DI core knows nothing about Tools.

The constructor and public method signatures of `ServiceProvider`, `ServiceScope`,
`ServiceCollection` and the `index.ts` facade are kept. The former behavior of errors,
repeated calls, keyed/open generics, Lazy and disposal is checked. The new classes need
no changes from consumers or in `DiContainer`.

`ClassProvider.activation` is an optional wrapping point for an already created class,
used by the cache. The field is absent by default; `null` is not allowed.
The object holds the required `deps: ProviderDependencyList` (`[]` is possible) and a
synchronous `wrap(instance, resolver, ...deps): T`. The wrapper's dependencies go
through the same visibility, lifetime, cycle and existence checks, but do not count as
constructor parameters. Sync/async resolve create the class with one mechanism.
The wrapper keeps the release of the original object; if it throws, DI keeps the
already created resource to release it on dispose. The error propagates; the instance
is not published into the singleton/scoped cache.
`ownership: "external"` and a keyed registration are kept when hooks apply.

This extension of the existing class provider is needed so the cache does not
duplicate the DI algorithm with its own factory. The core does not import cache/HTTP/ORM.

## 6. Checks and the readiness boundary

Checked on macOS arm64, Bun 1.4.0 / `34cbb9a40`, through the pinned launcher.
Detailed results, the source snapshot and the commands are in the
[refactoring report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/di-structure-2026-09-19.md).

| Check | Result |
| --- | --- |
| The original DI suite | 148 PASS / 0 FAIL / 733 assertions |
| DI after the refactoring and an extra nested keyed materialization case | 149 PASS / 0 FAIL / 739 assertions |
| Strict TypeScript for DI | PASS |
| 20 000 scopes, release and observation after GC | PASS; 0 retained scopes/resources |
| Root dispose with 128 unfinished factories | PASS; 128 resolve rejections, 128 released resources |
| Comparison of three alternating runs of 20 000 scopes | Median 124 ms before and 124 ms after; a synthetic scenario, not an SLA |
| Building DI into a binary and running it outside the source checkout | PASS; 64 modules |

The checks apply to DI. Qualification of other platforms and application components is
not part of this structural work.

After the registration selection optimization: **156 PASS / 0 FAIL / 863 assertions**,
16 files; strict TypeScript PASS. Added checks of key distinction, generic lookup
invalidation, module visibility and lifetime on a warm cache, isolation of scoped
instances, independence of public arrays and bounded growth of the new caches with
10 000 missing keys.
Measurements, the binary check and the limits of the result are in the
[performance report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/di-performance-2026-09-19/REPORT.md).

Checks of the 2026-10-02 fixes: the DI regressions of constructor identity, late
bootstrap, module cycles, choosing the token/key/generic owner and wrapper activation
are part of the sequential suite **693 PASS / 0 FAIL**.
TypeScript, real codegen and a standalone binary: PASS. Commands, a separate HTTP run
and intermediate failures are kept in the
[fixes report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/framework-architecture-2026-10-02/FIXES.md).

### Hosted service plan check (2026-10-02)

The optional `HostedService.planValidator: HostedServicePlanValidator` describes the
rule of a capability owner. The `validate(services, signal?)` method returns
void/Promise<void>; its signature is kept. It is a pure repeatable configuration check:
the same validator object is called once per plan version.
The initial version is checked before the first hook/start; replacing a supervised
service after a failed attempt rechecks the whole plan, including services already
started. A validator does not start work, does not require a "not started yet" state
and does not rely on being called once per application lifetime. This clarifies the
former contract; the stateless ORM validator matches it.

The internal [HostedServicePlan](internal/HostedServicePlan.ts) first unwraps all
nested supervised wrappers, then passes each validator the same frozen array of real
instances in registration order. No Proxy, no copies of services and no phase changes
are used; WeakMap/brand identity is kept. Factory cycles and the same instance repeated
in different positions of such a plan are rejected before the check and the start. The
Kernel sorts by phase after preparation; Application and the helpers keep the
registration order.

Fix of 2026-10-04: the plan is built through `resolveHostedServices`, which keeps each
instance from `resolveAll(HOSTED_SERVICE)` once, in the order of its first registration.
Several registrations of one singleton (the shared owned-store plan for all `ormBazis`
configurations with `ownedStore`) are one service, started and stopped once. Before,
the kernel rejected such a module as a duplicate identity before any admission.
Different supervised wrappers of one concrete instance are still rejected. Regression:
[orm.owned-store.lifecycle.test.ts](../orm/test/orm.owned-store.lifecycle.test.ts)
and the live E327 [orm.owned-store.core.postgres.live.test.ts](../orm/test/orm.owned-store.core.postgres.live.test.ts).

The [hosted-service](extensions/hosted-service.ts) extension provides the framework-only
bridge `registerHostedServiceWrapper`/`HostedServicePlanAdmission`: prepare creates an
object without startup effects, bind gets the phase and the replace operation. The
bridge is not exported by the root DI facade and adds no application field to
HostedService. The Kernel uses this existing extension input; DI does not import the
Kernel/ORM. Replacements are serialized inside the plan: a candidate is checked together
with its current neighbors and then published atomically. A failed/cancelled check keeps
the old version; a stale wrapper cannot change another plan. The phases of root positions
are fixed at the initial admission and do not change on retry. With any validator
present, the wrapper's effective phase must match the phase of the real service.
Cancellation bounds the validator wait and forbids a late bind/further checks.
Without a wrapper and a validator the former synchronous absence of a check is kept.
A wrapper instance belongs to one host run; sharing one wrapper between several hosts
at once is not a supported ownership model.

Lifecycle fixes of 2026-10-02: `Application.start` checks the plan inside the shared
startup error handling, before the first `start`; a validator rejection stays the main
error, and the container is released. The public signatures are kept.
The helpers keep the instance before calling its `start`, by resolver identity in a
`WeakMap`, and use the same list on stop, so the transient lifetime of
`addHostedService` does not change. Stop waits for a running start and stops all
instances whose start was called, in reverse order, including a service that got a
resource before a startup error. Services that were never started are not stopped.
An error of one stop does not stop the cleanup of the others; after it one original
error or an `AggregateError` with all stop errors is returned.
A repeated stop shares the result of the completed cleanup. After it finishes, a new
start is allowed. A startup error by itself does not call dispose: these low-level
helpers keep the caller responsible for cleanup.
Regressions: [di.hosted-lifecycle.test.ts](test/di.hosted-lifecycle.test.ts).

### The built-in ServiceProvider dependency (2026-10-02)

`createContainer` registers the root container itself under the public
`SERVICE_PROVIDER` and the canonical class token `ServiceProvider`. The internal
`SERVICE_PROVIDER_BY_TYPE` refers to this class: a separate InjectionToken with the same
name is no longer created. So modern generated descriptors by constructor identity and
the older string `ServiceProvider`/`lazy:ServiceProvider` resolve one container without
name ambiguity. The singleton and global registrations, the factory and the public
`SERVICE_PROVIDER` are kept; getting it through a child scope returns the root. Another
class with the same name stays an independent token. The container itself is not added
to its own list of disposable resources. The lower `ServiceCollection` still does not add
module infrastructure automatically. Codegen and the descriptor format did not change.
Regressions are in [di.architecture-regressions.test.ts](test/di.architecture-regressions.test.ts).
