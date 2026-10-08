export type { BuildServiceProviderOptions, ServiceKey, ServiceResolver } from "./types";
export { ServiceCollection } from "./ServiceCollection";
export { ServiceProvider } from "./ServiceProvider";
export { ServiceScope } from "./ServiceScope";
export { DiContainer } from "./container";
export * from "./extensions";
export {
  AmbiguousNamedDependencyError,
  AsyncResolutionRequiredError,
  CircularDependencyError,
  ClassDependenciesMismatchError,
  DiError,
  InvalidProviderError,
  ModuleEncapsulationError,
  ModuleOwnedProviderConflictError,
  NamedDependencyNotFoundError,
  OptionsValidationError,
  ProviderNotFoundError,
  ScopeDisposedError,
  ScopedServiceFromRootError,
  ServiceValidationError,
} from "./errors";
export {
  createContainer,
  type CreateContainerOptions,
  collectModuleControllers,
  collectModuleConfigs,
  collectModuleUiProfiles,
  Global,
  markGlobal,
  Module,
  DI,
  registerModuleMetadataExpander,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  expandModuleMetadata,
  createModuleOwnedMetadataChannel,
  createModuleOwnedProviderChannel,
  scoped,
  singleton,
  singletonAsyncFactory,
  singletonAsyncFactoryWithResolver,
  singletonFactory,
  singletonFactoryWithResolver,
  singletonValue,
  transient,
  type DiRegistrar,
  type ModuleConfig,
  type ModuleExport,
  type ModuleMetadataExpander,
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
  type BazisModule,
  type BazisModuleMetadata,
  type BazisModuleRef,
} from "./module";
export {
  CLASS_PROVIDER_HOOK,
  type ClassProviderHook,
  type ClassProviderRegistration,
} from "./module/classProviderHooks";
export {
  registerNamedDependencyEncapsulationHook,
  type NamedDependencyEncapsulationContext,
  type NamedDependencyEncapsulationHook,
} from "./module/encapsulationHooks";
export {
  createOpenGenericTokenFamily,
  createToken,
  type AbstractClass,
  type Class,
  type InjectionToken,
  type OpenGenericTokenFamily,
  type Token,
} from "./token";
export { ProviderDefinition, keyedDependency, lazyDependency, namedDependency } from "./provider";
export type {
  AsyncFactoryProvider,
  ClassProvider,
  FactoryProvider,
  KeyedDependency,
  Lazy,
  LazyDependency,
  NamedDependency,
  Provider,
  ProviderDependencyList,
  ProviderLifetime,
  ResolvedDeps,
  ValueProvider,
} from "./provider";
