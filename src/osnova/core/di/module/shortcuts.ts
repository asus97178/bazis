import type { Class, Token } from "../token";
import type { ServiceResolver } from "../types";
import type {
  ProviderDefinition,
  ProviderDependencyList,
  ResolvedDeps,
} from "../provider";
import { applyClassProviderHooks } from "./classProviderHooks";
import { DI } from "./DI";

function registerClassProvider<T, D extends ProviderDependencyList>(
  lifetime: "singleton" | "scoped" | "transient",
  provide: Token<T>,
  useClass: Class<T>,
  deps?: D,
): ProviderDefinition<T> {
  const hooked = applyClassProviderHooks({
    lifetime,
    provide: provide as Token<unknown>,
    useClass: useClass as Class<unknown>,
    deps,
  });
  if (hooked !== undefined) {
    return hooked as ProviderDefinition<T>;
  }
  const factory = lifetime === "singleton" ? DI.singleton : lifetime === "scoped" ? DI.scoped : DI.transient;
  return factory(DI.classProvider(provide, useClass, deps));
}

export function singleton<T>(useClass: Class<T>): ProviderDefinition<T>;
export function singleton<T, D extends ProviderDependencyList = []>(
  provide: Token<T>,
  useClass: Class<T>,
  deps?: D,
): ProviderDefinition<T>;
export function singleton<T, D extends ProviderDependencyList = []>(
  provide: Token<T>,
  useClass?: Class<T>,
  deps?: D,
): ProviderDefinition<T> {
  if (!useClass) {
    const classOnly = provide as Class<T>;
    return registerClassProvider("singleton", classOnly, classOnly);
  }

  return registerClassProvider("singleton", provide, useClass, deps);
}

export function scoped<T>(useClass: Class<T>): ProviderDefinition<T>;
export function scoped<T, D extends ProviderDependencyList = []>(
  provide: Token<T>,
  useClass: Class<T>,
  deps?: D,
): ProviderDefinition<T>;
export function scoped<T, D extends ProviderDependencyList = []>(
  provide: Token<T>,
  useClass?: Class<T>,
  deps?: D,
): ProviderDefinition<T> {
  if (!useClass) {
    const classOnly = provide as Class<T>;
    return registerClassProvider("scoped", classOnly, classOnly);
  }

  return registerClassProvider("scoped", provide, useClass, deps);
}

export function transient<T>(useClass: Class<T>): ProviderDefinition<T>;
export function transient<T, D extends ProviderDependencyList = []>(
  provide: Token<T>,
  useClass: Class<T>,
  deps?: D,
): ProviderDefinition<T>;
export function transient<T, D extends ProviderDependencyList = []>(
  provide: Token<T>,
  useClass?: Class<T>,
  deps?: D,
): ProviderDefinition<T> {
  if (!useClass) {
    const classOnly = provide as Class<T>;
    return registerClassProvider("transient", classOnly, classOnly);
  }

  return registerClassProvider("transient", provide, useClass, deps);
}

export function singletonFactory<T, D extends ProviderDependencyList>(
  provide: Token<T>,
  deps: D,
  useFactory: (...args: ResolvedDeps<D>) => T,
): ProviderDefinition<T> {
  return DI.singleton(DI.factoryProvider(provide, deps, useFactory));
}

export function singletonFactoryWithResolver<T, D extends ProviderDependencyList>(
  provide: Token<T>,
  deps: D,
  useFactory: (resolver: ServiceResolver, ...args: ResolvedDeps<D>) => T,
): ProviderDefinition<T> {
  return DI.singleton(DI.factoryProviderWithResolver(provide, deps, useFactory));
}

export function singletonAsyncFactory<T, D extends ProviderDependencyList>(
  provide: Token<T>,
  deps: D,
  useAsyncFactory: (...args: ResolvedDeps<D>) => Promise<T>,
): ProviderDefinition<T> {
  return DI.singleton(DI.asyncFactoryProvider(provide, deps, useAsyncFactory));
}

export function singletonAsyncFactoryWithResolver<T, D extends ProviderDependencyList>(
  provide: Token<T>,
  deps: D,
  useAsyncFactory: (resolver: ServiceResolver, ...args: ResolvedDeps<D>) => Promise<T>,
): ProviderDefinition<T> {
  return DI.singleton(DI.asyncFactoryProviderWithResolver(provide, deps, useAsyncFactory));
}

export function singletonValue<T>(provide: Token<T>, useValue: T): ProviderDefinition<T> {
  return DI.singleton(DI.valueProvider(provide, useValue));
}
