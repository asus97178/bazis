import type { Class, Token } from "../../token";
import type { ServiceResolver } from "../../types";
import type { ProviderDependencyList } from "./ProviderDependencyList";
import type { ProviderOwnershipOptions } from "./ProviderOwnership";

export interface ClassProvider<T, D extends ProviderDependencyList = []> extends ProviderOwnershipOptions {
  readonly provide: Token<T>;
  readonly useClass: Class<T>;
  readonly deps?: D;
  /** Optional synchronous wrapper applied after normal constructor activation.
   * Its dependencies participate in graph, lifetime and module validation.
   * The wrapper must preserve disposal of the created instance.
   */
  readonly activation?: {
    readonly deps: ProviderDependencyList;
    wrap(instance: T, resolver: ServiceResolver, ...deps: unknown[]): T;
  };
}
