import { getClassDeps } from "./classDeps";
import { getGeneratedClassDeps } from "../module/autoDeps";
import { isClassProvider, isValueProvider, type ClassProvider, type Provider, type ProviderDependencyList } from "../provider";

/** Constructor binding has one precedence rule in validation and activation. */
export function getConstructorDeps(provider: ClassProvider<unknown, ProviderDependencyList>): ProviderDependencyList {
  return provider.deps ?? getClassDeps(provider.useClass) ?? getGeneratedClassDeps(provider.useClass) ?? [];
}

export function getProviderDeps(provider: Provider<unknown>): ProviderDependencyList {
  if (isValueProvider(provider)) return [];
  if (!isClassProvider(provider)) return provider.deps;
  const deps = getConstructorDeps(provider);
  return provider.activation ? [...deps, ...provider.activation.deps] : deps;
}

/** Preserve the constructor/wrapper boundary when rebinding named deps. */
export function withProviderDeps(provider: Provider<unknown>, deps: ProviderDependencyList): Provider<unknown> {
  if (!isClassProvider(provider) || !provider.activation) return { ...provider, deps } as Provider<unknown>;
  const count = getConstructorDeps(provider).length;
  return {
    ...provider,
    deps: deps.slice(0, count),
    activation: { ...provider.activation, deps: deps.slice(count) },
  };
}
