import type { Provider, ProviderLifetime } from "../provider";
import type { Token } from "../token";
import type { ServiceKey } from "../types";

export class ServiceRegistration<T = unknown> {
  public constructor(
    public readonly id: number,
    public readonly token: Token<T>,
    public readonly provider: Provider<T>,
    public readonly lifetime: ProviderLifetime,
    public readonly key?: ServiceKey,
    public readonly fromOpenGeneric = false,
  ) {}
}
