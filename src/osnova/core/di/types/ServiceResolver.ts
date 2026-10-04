import type { Token } from "../token";
import type { ServiceKey } from "./ServiceKey";

export interface ServiceResolver {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): readonly T[];
  resolveKeyed<T>(token: Token<T>, key: ServiceKey): T;
  resolveAllKeyed<T>(token: Token<T>, key: ServiceKey): readonly T[];
  /** Resolves a service whose chain may contain async factories. */
  resolveAsync<T>(token: Token<T>): Promise<T>;
  resolveKeyedAsync<T>(token: Token<T>, key: ServiceKey): Promise<T>;
  /** Returns the service or undefined when no provider is registered (other errors propagate). */
  tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined;
  /** Checks whether a provider is registered for the token (and key, if given). */
  has(token: Token<unknown>, key?: ServiceKey): boolean;
}
