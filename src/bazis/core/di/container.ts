import type { OpenGenericRegistration } from "./internal/OpenGenericRegistration";
import { ServiceProvider } from "./ServiceProvider";
import type { BuildServiceProviderOptions } from "./types";
import type { ProviderDefinition } from "./provider";
import type {
  ModuleOwnedMetadataChannel,
  ModuleOwnedMetadataContribution,
  ModuleOwnedProviderChannel,
  ModuleOwnedProviderContribution,
  ModuleOwnedContributionStore,
} from "./module/moduleOwnedProviderContributors";

const EMPTY_MODULE_OWNED_CONTRIBUTIONS: readonly never[] = Object.freeze([]);

export class DiContainer extends ServiceProvider {
  public constructor(
    definitions: readonly ProviderDefinition[],
    openGenericRegistrations: readonly OpenGenericRegistration[],
    options?: BuildServiceProviderOptions,
    private readonly moduleOwnedContributions?: ModuleOwnedContributionStore,
  ) {
    super(definitions, openGenericRegistrations, options);
  }

  /** Returns only records for the caller-held opaque provider channel. */
  public getModuleOwnedProviderContributions<TPayload, TService>(
    channel: ModuleOwnedProviderChannel<TPayload, TService>,
  ): readonly ModuleOwnedProviderContribution<TPayload, TService>[] {
    return this.moduleOwnedContributions?.getProvider(channel) ?? EMPTY_MODULE_OWNED_CONTRIBUTIONS;
  }

  /** Returns only records for the caller-held opaque metadata channel. */
  public getModuleOwnedMetadataContributions<TPayload>(
    channel: ModuleOwnedMetadataChannel<TPayload>,
  ): readonly ModuleOwnedMetadataContribution<TPayload>[] {
    return this.moduleOwnedContributions?.getMetadata(channel) ?? EMPTY_MODULE_OWNED_CONTRIBUTIONS;
  }
}
