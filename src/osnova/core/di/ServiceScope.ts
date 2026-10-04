import { ResolutionScopeState } from "./internal/ResolutionScopeState";
import type { Token } from "./token";
import type { ServiceKey } from "./types";

interface ScopeResolver {
  resolveForScope<T>(token: Token<T>, scopeState: ResolutionScopeState): T;
  resolveAllForScope<T>(token: Token<T>, scopeState: ResolutionScopeState): readonly T[];
  resolveKeyedForScope<T>(token: Token<T>, key: ServiceKey, scopeState: ResolutionScopeState): T;
  resolveAllKeyedForScope<T>(
    token: Token<T>,
    key: ServiceKey | undefined,
    scopeState: ResolutionScopeState,
  ): readonly T[];
  resolveAsyncForScope<T>(token: Token<T>, key: ServiceKey | undefined, scopeState: ResolutionScopeState): Promise<T>;
  tryResolveForScope<T>(token: Token<T>, key: ServiceKey | undefined, scopeState: ResolutionScopeState): T | undefined;
  has(token: Token<unknown>, key?: ServiceKey): boolean;
  disposeScope(scopeState: ResolutionScopeState): Promise<void>;
}

export class ServiceScope {
  public constructor(
    private readonly provider: ScopeResolver,
    private readonly state: ResolutionScopeState,
  ) {}

  public resolve<T>(token: Token<T>): T {
    return this.provider.resolveForScope(token, this.state);
  }

  public resolveAll<T>(token: Token<T>): readonly T[] {
    return this.provider.resolveAllForScope(token, this.state);
  }

  public resolveKeyed<T>(token: Token<T>, key: ServiceKey): T {
    return this.provider.resolveKeyedForScope(token, key, this.state);
  }

  public resolveAllKeyed<T>(token: Token<T>, key: ServiceKey): readonly T[] {
    return this.provider.resolveAllKeyedForScope(token, key, this.state);
  }

  public resolveAsync<T>(token: Token<T>): Promise<T> {
    return this.provider.resolveAsyncForScope(token, undefined, this.state);
  }

  public resolveKeyedAsync<T>(token: Token<T>, key: ServiceKey): Promise<T> {
    return this.provider.resolveAsyncForScope(token, key, this.state);
  }

  public tryResolve<T>(token: Token<T>, key?: ServiceKey): T | undefined {
    return this.provider.tryResolveForScope(token, key, this.state);
  }

  public has(token: Token<unknown>, key?: ServiceKey): boolean {
    return this.provider.has(token, key);
  }

  public async dispose(): Promise<void> {
    await this.provider.disposeScope(this.state);
  }
}
