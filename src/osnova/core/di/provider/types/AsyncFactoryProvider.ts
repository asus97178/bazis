import type { Token } from "../../token";
import type { ServiceResolver } from "../../types";
import type { ProviderDependencyList } from "./ProviderDependencyList";
import type { ResolvedDeps } from "./ResolvedDeps";
import type { ProviderOwnershipOptions } from "./ProviderOwnership";

export interface AsyncFactoryProvider<T, D extends ProviderDependencyList = []> extends ProviderOwnershipOptions {
  readonly provide: Token<T>;
  readonly useAsyncFactory:
    | ((resolver: ServiceResolver, ...args: ResolvedDeps<D>) => Promise<T>)
    | ((...args: ResolvedDeps<D>) => Promise<T>);
  readonly deps: D;
  /** Same explicit contract as FactoryProvider: resolver is passed only when true. */
  readonly withResolver?: boolean;
}
