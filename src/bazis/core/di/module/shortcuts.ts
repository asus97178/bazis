import type { Class, Token } from "../token";
import type { ProviderDefinition, ProviderDependencyList, ResolvedDeps } from "../provider";
import { DI } from "./DI";

type Lifetime = "singleton" | "scoped" | "transient";

/** A class under its contract, or under itself. Its constructor dependencies come from codegen. */
function classProvider<T>(lifetime: Lifetime, provide: Token<T>, useClass: Class<T> | undefined): ProviderDefinition<T> {
  const register = lifetime === "singleton" ? DI.singleton : lifetime === "scoped" ? DI.scoped : DI.transient;
  return register(DI.classProvider(provide, useClass ?? (provide as Class<T>)));
}

/**
 * One instance for the whole application.
 *
 * ```ts
 * singleton(IClock, SystemClock) // under a contract
 * singleton(Metrics)             // the class is its own contract
 * ```
 */
export function singleton<T>(useClass: Class<T>): ProviderDefinition<T>;
export function singleton<T>(provide: Token<T>, useClass: Class<T>): ProviderDefinition<T>;
export function singleton<T>(provide: Token<T>, useClass?: Class<T>): ProviderDefinition<T> {
  return classProvider("singleton", provide, useClass);
}

/** One instance per scope: an HTTP request, a job, a message. */
export function scoped<T>(useClass: Class<T>): ProviderDefinition<T>;
export function scoped<T>(provide: Token<T>, useClass: Class<T>): ProviderDefinition<T>;
export function scoped<T>(provide: Token<T>, useClass?: Class<T>): ProviderDefinition<T> {
  return classProvider("scoped", provide, useClass);
}

/** A new instance each time it is asked for. */
export function transient<T>(useClass: Class<T>): ProviderDefinition<T>;
export function transient<T>(provide: Token<T>, useClass: Class<T>): ProviderDefinition<T>;
export function transient<T>(provide: Token<T>, useClass?: Class<T>): ProviderDefinition<T> {
  return classProvider("transient", provide, useClass);
}

/**
 * A resource that is created asynchronously, once, at startup: a connection, a
 * loaded key. Everything else is a class with a constructor.
 */
export function singletonAsyncFactory<T, D extends ProviderDependencyList>(
  provide: Token<T>,
  deps: D,
  useAsyncFactory: (...args: ResolvedDeps<D>) => Promise<T>,
): ProviderDefinition<T> {
  return DI.singleton(DI.asyncFactoryProvider(provide, deps, useAsyncFactory));
}

/** A ready value under a token: a constant, a test double. */
export function singletonValue<T>(provide: Token<T>, useValue: T): ProviderDefinition<T> {
  return DI.singleton(DI.valueProvider(provide, useValue));
}
