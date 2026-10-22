export { DI } from "./DI";
export { Global, markGlobal } from "./Global";
export { Module } from "./Module";
export type { DiRegistrar, ModuleConfig, ModuleExport, BazisModule, BazisModuleMetadata, BazisModuleRef } from "./types";
export { ModuleRegistrar } from "./ModuleRegistrar";
export {
  registerModuleMetadataExpander,
  expandModuleMetadata,
  deferModuleDeclarationError,
  type ModuleMetadataExpander,
} from "./moduleExtensions";
export {
  createModuleOwnedMetadataChannel,
  createModuleOwnedProviderChannel,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  type ModuleOwnedContributionChannel,
  type ModuleOwnedContributionSnapshot,
  type ModuleOwnedValidationSnapshot,
  type ModuleOwnedContributionValidator,
  type ModuleOwnedMetadataChannel,
  type ModuleOwnedMetadataContribution,
  type ModuleOwnedProviderActivation,
  type ModuleOwnedProviderChannel,
  type ModuleOwnedProviderContribution,
  type ModuleOwnedProviderContributionContext,
  type ModuleOwnedProviderContributor,
} from "./moduleOwnedProviderContributors";
export { createContainer, type CreateContainerOptions } from "./createContainer";
export { collectModuleControllers, collectModuleGateways } from "./collectModuleControllers";
export { collectModuleConfigs } from "./collectModuleConfigs";
export { collectModuleUiProfiles } from "./collectModuleUiProfiles";
export {
  scoped,
  singleton,
  singletonAsyncFactory,
  singletonAsyncFactoryWithResolver,
  singletonFactory,
  singletonFactoryWithResolver,
  singletonValue,
  transient,
} from "./shortcuts";
