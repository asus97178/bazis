import type { Token } from "../../token";
import type { ServiceResolver } from "../../types";
import type { ProviderDependencyList } from "./ProviderDependencyList";
import type { ResolvedDeps } from "./ResolvedDeps";
import type { ProviderOwnershipOptions } from "./ProviderOwnership";

export interface FactoryProvider<T, D extends ProviderDependencyList = []> extends ProviderOwnershipOptions {
  readonly provide: Token<T>;
  readonly useFactory:
    | ((resolver: ServiceResolver, ...args: ResolvedDeps<D>) => T)
    | ((...args: ResolvedDeps<D>) => T);
  readonly deps: D;
  /**
   * When true, the container passes a `ServiceResolver` as the first factory
   * argument. This is an explicit contract: the container never guesses the
   * factory signature (e.g. via `Function.length`, which breaks with default
   * and rest parameters).
   */
  readonly withResolver?: boolean;
}
