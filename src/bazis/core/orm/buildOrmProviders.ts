import { DI, HOSTED_SERVICE, type InjectionToken, type ModuleOwnedContributionSnapshot, type ProviderDefinition } from "../di";
import { HEALTH_CHECK } from "../kernel";
import { DbContextOptions, type DatabaseProvider, type DbContext } from "../../library/orm";
import { OrmLifecycle } from "./OrmLifecycle";
import { ownedStoreLifecycleFor, ownedStoreLifecycleHealthFor } from "./OrmOwnedStoreLifecycle";
import { effectiveOrmModuleConfig, ownedStoreRegistrations } from "./ownedStoreContributions";
import { SERVICE_PROVIDER } from "../di";
import { DATABASE_PROVIDER } from "./DATABASE_PROVIDER";
import type { OrmModuleConfig } from "./ormModule";

type EntityClass = new () => object;
type ContextClass<TContext extends DbContext> = new (options: DbContextOptions) => TContext;

type OrmBuildConfig<TContext extends DbContext> = OrmModuleConfig<TContext> & {
  readonly context: ContextClass<TContext>;
};

function createContextOptions<TContext extends DbContext>(
  config: OrmBuildConfig<TContext>,
  provider: DatabaseProvider,
): DbContextOptions {
  return new DbContextOptions({
    provider,
    entities: config.entities ?? [],
    validateOnSave: config.validateOnSave,
    executionStrategy: config.executionStrategy,
  });
}

function createOrmLifecycle<TContext extends DbContext>(
  config: OrmBuildConfig<TContext>,
  options: DbContextOptions,
  ownsConnection: boolean,
): OrmLifecycle {
  return new OrmLifecycle(
    options,
    config.ensureCreated === true,
    config.migrateOnStart === true,
    config.migrations ?? [],
    config.runMigrationsOnStart === true,
    ownsConnection,
  );
}


function isInjectionToken(value: unknown): value is InjectionToken<DatabaseProvider> {
  return typeof value === "object" && value !== null && "id" in value && "description" in value;
}

function effectiveConfigFor<TContext extends DbContext>(
  serviceProvider: unknown,
  registrationIdentity: object | undefined,
  fallback: OrmBuildConfig<TContext>,
): OrmBuildConfig<TContext> {
  const container = serviceProvider as import("../di").DiContainer;
  const snapshot = {
    getProviderContributions: container.getModuleOwnedProviderContributions.bind(container),
    getMetadataContributions: container.getModuleOwnedMetadataContributions.bind(container),
  } as unknown as ModuleOwnedContributionSnapshot;
  ownedStoreRegistrations(snapshot);
  return effectiveOrmModuleConfig(snapshot, registrationIdentity, fallback);
}

export function buildOrmModuleProviders<TContext extends DbContext>(
  config: OrmBuildConfig<TContext>,
  providerOrToken: DatabaseProvider | InjectionToken<DatabaseProvider>,
  registrationIdentity?: object,
  optionsAtModuleCall?: DbContextOptions,
): ProviderDefinition[] {
  if (isInjectionToken(providerOrToken)) {
    const token = providerOrToken;
    const providers: ProviderDefinition[] = [
      DI.scoped(
        DI.factoryProvider(config.context, [token, SERVICE_PROVIDER] as const, (provider: DatabaseProvider, serviceProvider) => {
          const current = effectiveConfigFor(serviceProvider, registrationIdentity, config);
          return new current.context(createContextOptions(current, provider));
        }),
      ),
      DI.singleton(
        DI.factoryProvider(HOSTED_SERVICE, [token, SERVICE_PROVIDER] as const, (provider: DatabaseProvider, serviceProvider) => {
          const current = effectiveConfigFor(serviceProvider, registrationIdentity, config);
          // Feature mode: the connection is shared (DATABASE_PROVIDER) and owned by
          // the infrastructure; only ensureCreated/migrations here, no close.
          if (current.ownedStore !== undefined) {
            const container = serviceProvider as import("../di").DiContainer;
            const records = ownedStoreRegistrations({
              getProviderContributions: (channel) => container.getModuleOwnedProviderContributions(channel),
              getMetadataContributions: (channel) => container.getModuleOwnedMetadataContributions(channel),
            });
            return ownedStoreLifecycleFor(container, provider, records);
          }
          return createOrmLifecycle(current, createContextOptions(current, provider), false);
        }),
      ),
    ];
    if (config.ownedStore !== undefined) {
      providers.push(DI.singleton(DI.factoryProvider(HEALTH_CHECK, [SERVICE_PROVIDER], (serviceProvider) => {
        const container = serviceProvider as unknown as import("../di").DiContainer;
        return { name: `orm-owned-store:${config.ownedStore!.storeKey}`, check: () => ownedStoreLifecycleHealthFor(container)?.check() ?? Promise.resolve({ healthy: false, details: "ORM_OWNED_STORE_NOT_READY" }) };
      })));
    }
    return providers;
  }

  const provider = providerOrToken;
  const providers: ProviderDefinition[] = [
    DI.scoped(DI.factoryProvider(config.context, [SERVICE_PROVIDER], (serviceProvider) => {
      const current = effectiveConfigFor(serviceProvider, registrationIdentity, config);
      const context = current === config ? config.context : current.context;
      return new context(current === config && optionsAtModuleCall !== undefined ? optionsAtModuleCall : createContextOptions(current, provider));
    })),
    // Standalone mode: the context owns its provider and closes it.
    DI.singleton(DI.factoryProvider(HOSTED_SERVICE, [SERVICE_PROVIDER], (serviceProvider) => {
      const current = effectiveConfigFor(serviceProvider, registrationIdentity, config);
      return createOrmLifecycle(current, current === config && optionsAtModuleCall !== undefined ? optionsAtModuleCall : createContextOptions(current, provider), true);
    })),
  ];
  return providers;
}

/** Connection health check for a concrete provider value. */
export function buildOrmHealthCheck(provider: DatabaseProvider): ProviderDefinition {
  return DI.singleton(
    DI.factoryProvider(HEALTH_CHECK, [], () => ({
      name: `database:${provider.name}`,
      check: () => checkProviderHealth(provider),
    })),
  );
}

/** Connection health check through the shared {@link DATABASE_PROVIDER} (feature mode). */
export function buildOrmHealthCheckFromToken(token: InjectionToken<DatabaseProvider>): ProviderDefinition {
  return DI.singleton(
    DI.factoryProvider(HEALTH_CHECK, [token], (provider: DatabaseProvider) => ({
      name: `database:${provider.name}`,
      check: () => checkProviderHealth(provider),
    })),
  );
}

async function checkProviderHealth(provider: DatabaseProvider): Promise<{ healthy: boolean; details?: string }> {
  const connected = await provider.ping();
  const diagnostics = provider.diagnostics?.() ?? [];
  const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const details = diagnostics.map((diagnostic) => `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}`);
  return {
    healthy: connected && !hasError,
    ...(details.length === 0 ? {} : { details: details.join("; ") }),
  };
}

export type { ContextClass, EntityClass, OrmBuildConfig };
