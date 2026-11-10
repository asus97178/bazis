/**
 * Low-level provider forms: providers built by hand, factories, dependency
 * lists, classes bound to their dependencies. The framework's own modules and
 * packages that extend it (a connector, a host) use them.
 *
 * An application does not need this entry point: it registers its services in
 * the agreed forms of `bazis/core/di` — `scoped(IService, Service)`,
 * `singleton(...)`, `transient(...)`, `singletonValue(TOKEN, value)`,
 * `singletonAsyncFactory(TOKEN, [deps], factory)` — and codegen refuses the
 * forms of this file in `@Module({ providers })` of an application.
 */
export { DI } from "./module/DI";
