import type { Class } from "../token";
import type { ProviderDependencyList } from "../provider";

const classDeps = new WeakMap<Function, ProviderDependencyList>();
export const CLASS_DEPS = Symbol("osnv.class.deps");

export function setClassDeps<C extends Class<unknown>, D extends ProviderDependencyList>(
  useClass: C,
  deps: D,
): void {
  classDeps.set(useClass as unknown as Function, deps);
}

export function getClassDeps(useClass: Class<unknown>): ProviderDependencyList | undefined {
  const fromMap = classDeps.get(useClass as unknown as Function);
  if (fromMap) {
    return fromMap;
  }

  const withDeps = useClass as unknown as {
    [CLASS_DEPS]?: ProviderDependencyList;
    inject?: ProviderDependencyList;
    deps?: ProviderDependencyList;
  };

  const fromSymbol = withDeps[CLASS_DEPS];
  if (fromSymbol) {
    return fromSymbol;
  }
  if (withDeps.inject) {
    return withDeps.inject;
  }
  if (withDeps.deps) {
    return withDeps.deps;
  }

  return undefined;
}
