import { setClassDeps } from "../internal/classDeps";
import type { Token } from "../token";
import type { ServiceKey, ServiceResolver } from "../types";
import type {
  AsyncFactoryProvider,
  ClassProvider,
  FactoryProvider,
  Provider,
  ProviderDefinition,
  ProviderDependencyList,
  ResolvedDeps,
  ValueProvider,
  KeyedDependency,
} from "../provider";
import { ProviderDefinition as ProviderDefinitionClass, keyedDependency } from "../provider";

export class DI {
  /** Marks a provider result as lifecycle-owned so the container will not dispose it. */
  public static externallyOwned<T, D extends ProviderDependencyList>(provider: FactoryProvider<T, D>): FactoryProvider<T, D>;
  public static externallyOwned<T, D extends ProviderDependencyList>(provider: AsyncFactoryProvider<T, D>): AsyncFactoryProvider<T, D>;
  public static externallyOwned<T, D extends ProviderDependencyList>(provider: ClassProvider<T, D>): ClassProvider<T, D>;
  public static externallyOwned<T>(provider: ValueProvider<T>): ValueProvider<T>;
  public static externallyOwned(provider: Provider<unknown>): Provider<unknown> {
    return { ...provider, ownership: "external" } as Provider<unknown>;
  }

  public static singleton<T>(provider: Provider<T>): ProviderDefinition<T> {
    return new ProviderDefinitionClass(provider, "singleton");
  }

  public static scoped<T>(provider: Provider<T>): ProviderDefinition<T> {
    return new ProviderDefinitionClass(provider, "scoped");
  }

  public static transient<T>(provider: Provider<T>): ProviderDefinition<T> {
    return new ProviderDefinitionClass(provider, "transient");
  }

  public static keyedSingleton<T>(key: ServiceKey, provider: Provider<T>): ProviderDefinition<T> {
    return new ProviderDefinitionClass(provider, "singleton", key);
  }

  public static keyedScoped<T>(key: ServiceKey, provider: Provider<T>): ProviderDefinition<T> {
    return new ProviderDefinitionClass(provider, "scoped", key);
  }

  public static keyedTransient<T>(key: ServiceKey, provider: Provider<T>): ProviderDefinition<T> {
    return new ProviderDefinitionClass(provider, "transient", key);
  }

  public static classProvider<T, D extends ProviderDependencyList = []>(
    provide: Token<T>,
    useClass: ClassProvider<T, D>["useClass"],
    deps?: D,
  ): ClassProvider<T, D> {
    return {
      provide,
      useClass,
      deps,
    };
  }

  public static factoryProvider<T, D extends ProviderDependencyList>(
    provide: Token<T>,
    deps: D,
    useFactory: (...args: ResolvedDeps<D>) => T,
  ): FactoryProvider<T, D> {
    return {
      provide,
      deps,
      useFactory,
    };
  }

  public static factoryProviderWithResolver<T, D extends ProviderDependencyList>(
    provide: Token<T>,
    deps: D,
    useFactory: (resolver: ServiceResolver, ...args: ResolvedDeps<D>) => T,
  ): FactoryProvider<T, D> {
    return {
      provide,
      deps,
      useFactory,
      withResolver: true,
    };
  }

  public static asyncFactoryProvider<T, D extends ProviderDependencyList>(
    provide: Token<T>,
    deps: D,
    useAsyncFactory: (...args: ResolvedDeps<D>) => Promise<T>,
  ): AsyncFactoryProvider<T, D> {
    return {
      provide,
      deps,
      useAsyncFactory,
    };
  }

  public static asyncFactoryProviderWithResolver<T, D extends ProviderDependencyList>(
    provide: Token<T>,
    deps: D,
    useAsyncFactory: (resolver: ServiceResolver, ...args: ResolvedDeps<D>) => Promise<T>,
  ): AsyncFactoryProvider<T, D> {
    return {
      provide,
      deps,
      useAsyncFactory,
      withResolver: true,
    };
  }

  public static valueProvider<T>(provide: Token<T>, useValue: T): ValueProvider<T> {
    return {
      provide,
      useValue,
    };
  }

  public static keyed<T>(token: Token<T>, key: ServiceKey): KeyedDependency<T> {
    return keyedDependency(token, key);
  }

  public static bindDeps<TCtorArgs extends unknown[], TInstance, D extends ProviderDependencyList>(
    useClass: CtorClass<TCtorArgs, TInstance>,
    ...deps: DepsCompatibleWithCtor<TCtorArgs, D>
  ): CtorClass<TCtorArgs, TInstance> {
    setClassDeps(useClass, deps);
    return useClass;
  }

  public static injectFor<TCtorArgs extends unknown[], TInstance, D extends ProviderDependencyList>(
    useClass: CtorClass<TCtorArgs, TInstance>,
    ...deps: DepsCompatibleWithCtor<TCtorArgs, D>
  ): D {
    setClassDeps(useClass, deps);
    return deps as D;
  }
}

type CtorClass<TArgs extends unknown[], TInstance> = new (...args: TArgs) => TInstance;

type DepsCompatibleWithCtor<TCtorArgs extends unknown[], D extends ProviderDependencyList> =
  ResolvedDeps<D> extends Readonly<TCtorArgs>
    ? D
    : never;
