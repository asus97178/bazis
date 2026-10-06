import { DiContainer } from "../container";
import { ServiceCollection } from "../ServiceCollection";
import { HOSTED_SERVICE, type HostedService } from "../extensions/hosted-service";
import { SERVICE_PROVIDER, SERVICE_PROVIDER_BY_TYPE } from "../extensions/service-provider-token";
import { isClassProvider, ProviderDefinition, type Provider } from "../provider";
import { getClassDeps } from "../internal/classDeps";
import { ModuleEncapsulationError } from "../errors";
import { OpenGenericRegistration } from "../internal/OpenGenericRegistration";
import type { Class } from "../token";
import type { BuildServiceProviderOptions } from "../types";
import { DI } from "./DI";
import { Global } from "./Global";
import { Module } from "./Module";
import { validateModuleEncapsulation, type ModuleGraphRecord } from "./encapsulation";
import { expandModuleMetadata } from "./moduleExtensions";
import {
  applyModuleOwnedProviderContributors,
  ModuleOwnedContributionStore,
  validateModuleOwnedContributions,
} from "./moduleOwnedProviderContributors";
import { createModuleScopedNameBinder } from "./moduleNameBinding";
import { createProviderSelectionValidator } from "./providerSelection";
import { ModuleRegistrar } from "./ModuleRegistrar";
import { scoped, singleton } from "./shortcuts";
import { getGeneratedClassDeps } from "./autoDeps";
import { applyClassProviderHooksToDefinition, collectClassProviderHooks } from "./classProviderHooks";
import type { BazisModuleRef } from "./types";

function moduleDiagnosticName(moduleRef: BazisModuleRef, fallbackIndex: number): string {
  if (typeof moduleRef === "function") {
    const name = moduleRef.name.trim();
    if (name.length > 0) {
      return name;
    }
  }
  return `module#${fallbackIndex}`;
}

export function createContainer(rootModule: BazisModuleRef, options?: BuildServiceProviderOptions): DiContainer {
  // The container itself is injectable (SERVICE_PROVIDER, .NET-style). The
  // instance does not exist until the end of this function, so the factory
  // closes over a ref that is assigned right after construction.
  let built: DiContainer | undefined;
  @Global()
  @Module({
    providers: [
      DI.singleton(
        DI.factoryProvider(SERVICE_PROVIDER, [], () => {
          if (!built) {
            throw new Error("SERVICE_PROVIDER resolved before the container finished building.");
          }
          return built;
        }),
      ),
      // Canonical class token for generated identity and name-based deps.
      DI.singleton(
        DI.factoryProvider(SERVICE_PROVIDER_BY_TYPE, [], () => {
          if (!built) {
            throw new Error("SERVICE_PROVIDER resolved before the container finished building.");
          }
          return built;
        }),
      ),
    ],
  })
  class BazisDiInfraModule {}

  const diInfraModule = BazisDiInfraModule;

  const collection = new ServiceCollection();
  const registrar = new ModuleRegistrar(collection);
  const records = new Map<BazisModuleRef, ModuleGraphRecord>();
  const moduleOwnedContributions = new ModuleOwnedContributionStore();
  // Which module declared each definition — used for module-scoped name binding.
  const recordOf = new Map<ProviderDefinition, ModuleGraphRecord>();
  const openGenericRecordOf = new Map<OpenGenericRegistration, ModuleGraphRecord>();
  const loading: BazisModuleRef[] = [];
  const activeModules = new Set<BazisModuleRef>();

  const loadModule = (moduleRef: BazisModuleRef): void => {
    if (activeModules.has(moduleRef)) {
      const cycle = [...loading.slice(loading.indexOf(moduleRef)), moduleRef]
        .map((ref) => records.get(ref)!.name).join(" -> ");
      throw new ModuleEncapsulationError([`Module imports cycle: ${cycle}`]);
    }
    if (records.has(moduleRef)) {
      return;
    }
    const record: ModuleGraphRecord = {
      name: moduleDiagnosticName(moduleRef, records.size),
      imports: [],
      exports: moduleRef.exports,
      global: moduleRef.global === true,
      providedTokens: new Set(),
      providedFamilies: new Set(),
      definitions: [],
    };
    records.set(moduleRef, record);
    activeModules.add(moduleRef);
    loading.push(moduleRef);

    const imports = moduleRef.imports;
    if (imports) {
      for (let index = 0; index < imports.length; index += 1) {
        const importedModule = imports[index] as BazisModuleRef;
        loadModule(importedModule);
        record.imports.push(records.get(importedModule) as ModuleGraphRecord);
      }
    }

    // Extra declarative keys (e.g. `ormBazis`) contributed by higher layers via
    // registered expanders — loaded exactly like `imports`.
    const expanded = expandModuleMetadata(moduleRef);
    for (let index = 0; index < expanded.length; index += 1) {
      const expandedModule = expanded[index] as BazisModuleRef;
      loadModule(expandedModule);
      record.imports.push(records.get(expandedModule) as ModuleGraphRecord);
    }

    const definitionsStart = collection.size;
    const openGenericsStart = collection.openGenericSize;

    const providers = moduleRef.providers;
    if (providers) {
      for (let index = 0; index < providers.length; index += 1) {
        collection.add(providers[index] as ProviderDefinition);
      }
    }

    const controllers = moduleRef.controllers;
    if (controllers) {
      for (let index = 0; index < controllers.length; index += 1) {
        collection.add(scoped(controllers[index] as Class<object>));
      }
    }

    const background = moduleRef.background;
    if (background) {
      for (let index = 0; index < background.length; index += 1) {
        const ServiceClass = background[index] as Class<HostedService>;
        // Singleton instance + a HOSTED_SERVICE entry resolving to it, so the
        // kernel starts/stops it with the rest of the app.
        collection.add(singleton(ServiceClass));
        collection.add(
          DI.singleton(DI.factoryProviderWithResolver(HOSTED_SERVICE, [], (resolver) => resolver.resolve(ServiceClass))),
        );
      }
    }

    moduleRef.configure?.(registrar);

    // Higher-layer declarative capabilities are registered while their owner
    // record is still open. This preserves access to private feature deps
    // without turning a contribution into a synthetic imported module.
    applyModuleOwnedProviderContributors(
      moduleRef,
      record.name,
      collection,
      moduleOwnedContributions,
      definitionsStart,
    );

    // Attribute everything registered by this module (providers + configure)
    // to its graph record for build-time encapsulation validation.
    // configure() may remove/replace earlier entries, moving array offsets.
    // New definitions still belong to this module even after such a mutation.
    const ownDefinitions = moduleRef.configure
      ? collection.toArray().filter((definition) => !recordOf.has(definition))
      : collection.definitionsFrom(definitionsStart);
    for (let index = 0; index < ownDefinitions.length; index += 1) {
      const definition = ownDefinitions[index] as ProviderDefinition;
      record.definitions.push(definition);
      record.providedTokens.add(definition.provider.provide);
      const providedToken = definition.provider.provide;
      if (typeof providedToken !== "function" && providedToken.genericFamilyId) {
        record.providedFamilies.add(providedToken.genericFamilyId);
      }
      recordOf.set(definition, record);
    }
    for (const registration of collection.openGenericsFrom(openGenericsStart)) {
      record.providedFamilies.add(registration.family.id);
      openGenericRecordOf.set(registration, record);
    }
    loading.pop();
    activeModules.delete(moduleRef);
  };

  loadModule(diInfraModule);
  loadModule(rootModule);
  const recordList = Array.from(records.values());
  const collectedDefinitions = collection.toArray();
  const classProviderHooks = collectClassProviderHooks(collectedDefinitions);
  const normalizeDefinition = (definition: ProviderDefinition): ProviderDefinition =>
    normalizeLateGeneratedClassDeps(applyClassProviderHooksToDefinition(definition, classProviderHooks));
  const activeDefinitions = new Set(collectedDefinitions);
  for (const record of recordList) {
    // Removed providers must not continue to contribute dependency checks.
    const active = record.definitions.filter((definition) => activeDefinitions.has(definition));
    record.definitions.splice(0, record.definitions.length, ...active);
  }
  const definitions = collectedDefinitions.map(normalizeDefinition);
  const normalizedRecordOf = new Map<ProviderDefinition, ModuleGraphRecord>();
  for (let index = 0; index < collectedDefinitions.length; index += 1) {
    const original = collectedDefinitions[index] as ProviderDefinition;
    const normalized = definitions[index] as ProviderDefinition;
    const record = recordOf.get(original);
    if (record) {
      normalizedRecordOf.set(normalized, record);
      const definitionIndex = record.definitions.indexOf(original);
      if (definitionIndex >= 0) {
        record.definitions[definitionIndex] = normalized;
      }
    }
  }
  moduleOwnedContributions.validateProviderExclusivity(collection.toArray());
  validateModuleOwnedContributions(moduleOwnedContributions, definitions);
  const validateDefinition = validateModuleEncapsulation(recordList);
  const bindDefinition = createModuleScopedNameBinder(recordList);
  const validateSelection = createProviderSelectionValidator(
    recordList, definitions, normalizedRecordOf, collection.openGenericToArray(), openGenericRecordOf,
  );
  const boundDefinitions = definitions.map((definition) => {
    const record = normalizedRecordOf.get(definition);
    if (!record) return definition;
    const bound = bindDefinition(definition, record);
    validateSelection(bound, record);
    return bound;
  });
  const openGenerics = collection.openGenericToArray().map((registration) => {
    const record = openGenericRecordOf.get(registration);
    if (!record) {
      return registration;
    }
    return new OpenGenericRegistration(registration.family, (argument) => {
      const definition = normalizeDefinition(new ProviderDefinition(
        registration.providerFactory(argument), registration.lifetime, registration.key,
      ));
      // Validate and bind before the container publishes the closed batch.
      // Root resolution still uses the generic declaration's module visibility.
      validateDefinition(definition, record);
      const bound = bindDefinition(definition, record);
      validateSelection(bound, record);
      return bound.provider;
    }, registration.lifetime, registration.key);
  });
  built = new DiContainer(boundDefinitions, openGenerics, options, moduleOwnedContributions);
  return built;
}

function normalizeLateGeneratedClassDeps(definition: ProviderDefinition): ProviderDefinition {
  const provider = definition.provider;
  if (!isClassProvider(provider) || provider.deps !== undefined || getClassDeps(provider.useClass) !== undefined) {
    return definition;
  }
  const generatedDeps = getGeneratedClassDeps(provider.useClass);
  if (generatedDeps === undefined) {
    return definition;
  }
  const normalizedProvider = { ...provider, deps: generatedDeps } as Provider<unknown>;
  return new ProviderDefinition(normalizedProvider, definition.lifetime, definition.key);
}
