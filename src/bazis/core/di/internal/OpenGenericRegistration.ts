import type { Provider, ProviderLifetime } from "../provider";
import type { OpenGenericTokenFamily, Token } from "../token";
import type { ServiceKey } from "../types";

export type OpenGenericProviderFactory = (argument: Token<unknown>) => Provider<unknown>;

export class OpenGenericRegistration {
  public constructor(
    public readonly family: OpenGenericTokenFamily<unknown, unknown>,
    public readonly providerFactory: OpenGenericProviderFactory,
    public readonly lifetime: ProviderLifetime,
    public readonly key?: ServiceKey,
  ) {}
}
