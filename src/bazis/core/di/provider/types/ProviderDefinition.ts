import type { ServiceKey } from "../../types";
import type { Provider } from "./Provider";
import type { ProviderLifetime } from "./ProviderLifetime";

export class ProviderDefinition<T = unknown> {
  public constructor(
    public readonly provider: Provider<T>,
    public readonly lifetime: ProviderLifetime,
    public readonly key?: ServiceKey,
  ) {}
}
