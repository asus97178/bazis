import { DI, HOSTED_SERVICE, singletonValue, type OsnvModuleRef, type ProviderDefinition } from "../di";
import {
  OrmError,
  type DatabaseProvider,
  type DbContext,
  DbContextOptions,
  type DbContextOptionsConfig,
  type Migration,
} from "../../library/orm";
import { DATABASE_PROVIDER } from "./DATABASE_PROVIDER";
import { IRepository } from "./repository";
import { registerRepositories } from "./registerRepositories";
import {
  buildOrmHealthCheck,
  buildOrmHealthCheckFromToken,
  buildOrmModuleProviders,
  type OrmBuildConfig,
} from "./buildOrmProviders";
import { OrmConnectionLifecycle } from "./OrmLifecycle";
import { attachOrmGraphContribution, attachOwnedStoreRegistration } from "./ownedStoreContributions";

type EntityClass = new () => object;
type ContextClass<TContext extends DbContext> = new (options: DbContextOptions) => TContext;

/**
 * The single ORM registration shape. One function, three scenarios depending
 * on which fields are passed:
 *
 * - **Connection** (`{ provider }`, no `context`): a global module that
 *   publishes the shared {@link DATABASE_PROVIDER}. Created once at the root.
 * - **Feature** (`{ context, entities }`, no `provider`): a context and its
 *   repositories connected to the shared {@link DATABASE_PROVIDER}.
 * - **Standalone** (`{ context, entities, provider }`): a context with its own
 *   provider (tests, isolated modules).
 *
 * The provider is a value (the ORM `postgres(...)`), not a nested module.
 */
export interface OrmModuleConfig<TContext extends DbContext> {
  /** Context class (a DbContext subclass). Omitted in the "connection" mode. */
  readonly context?: ContextClass<TContext>;
  /** Entities mapped by this context. */
  readonly entities?: readonly EntityClass[];
  /**
   * Database provider value (`postgres(...)`). Without it the context connects
   * to the shared {@link DATABASE_PROVIDER} (feature mode).
   */
  readonly provider?: DatabaseProvider;
  /** Validate entities before SaveChanges (default true). */
  readonly validateOnSave?: boolean;
  /** Create the schema at start (`CREATE TABLE IF NOT EXISTS`). Default false. */
  readonly ensureCreated?: boolean;
  /**
   * Run the additive auto-migration at start for all context entities.
   * Only the module decides how the schema is created. Default false.
   */
  readonly migrateOnStart?: boolean;
  /** Versioned migrations (a compile-safe array). History is kept in `__OsnvMigrations`. */
  readonly migrations?: readonly Migration[];
  /** Run `migrateVersioned` at start (default false). */
  readonly runMigrationsOnStart?: boolean;
  /** Retries on transient database errors in SaveChanges. */
  readonly executionStrategy?: DbContextOptionsConfig["executionStrategy"];
  /**
   * Register the connection health check. Default: on for the "connection" and
   * "standalone" modes, off for feature (the root turns it on).
   */
  readonly healthCheck?: boolean;
  /** Register scoped `IRepository<T>` for the entities (default true). */
  readonly registerRepositories?: boolean;
  /** Modules holding the context's dependencies. */
  readonly imports?: readonly OsnvModuleRef[];
  /** Approved owned PostgreSQL store descriptor; admission is owned by the core lifecycle. */
  readonly ownedStore?: import("../../library/orm").OrmOwnedStoreDefinitionV1;
}

function defineFeatureOrmModule<TContext extends DbContext>(
  config: OrmBuildConfig<TContext>,
  providers: ProviderDefinition[],
): OsnvModuleRef {
  const withRepositories = config.registerRepositories !== false;

  return {
    imports: config.imports,
    providers,
    exports: withRepositories ? [config.context, IRepository] : [config.context],
    configure: withRepositories
      ? (di) => registerRepositories(di, config.context, config.entities ?? [])
      : undefined,
  };
}

function defineConnectionModule(provider: DatabaseProvider, healthCheck: boolean): OsnvModuleRef {
  const providers: ProviderDefinition[] = [
    singletonValue(DATABASE_PROVIDER, provider),
    DI.singleton(
      DI.factoryProvider(
        HOSTED_SERVICE,
        [DATABASE_PROVIDER],
        (registered: DatabaseProvider) => new OrmConnectionLifecycle(registered),
      ),
    ),
  ];
  if (healthCheck) {
    providers.push(buildOrmHealthCheck(provider));
  }

  return { global: true, providers, exports: [DATABASE_PROVIDER] };
}

/** Single ORM registration entry point (see {@link OrmModuleConfig}). */
export function ormModule<TContext extends DbContext>(config: OrmModuleConfig<TContext>): OsnvModuleRef {
  if (config.ownedStore !== undefined) {
    if (!config.context || !config.entities || config.entities.length === 0 || config.provider || config.ensureCreated || config.migrateOnStart || config.runMigrationsOnStart || config.migrations !== undefined) {
      throw new OrmError("ORM owned store requires a context and entities and cannot compose startup schema or migration authority.");
    }
    // Provider factories outlive this call. Keep their context/entity view
    // registration-local so a caller cannot mutate the descriptor afterwards
    // and silently change the runtime graph behind its owned receipt.
    const buildConfig = Object.freeze({ ...config, context: config.context, entities: Object.freeze([...config.entities]) }) as OrmBuildConfig<TContext>;
    const module = defineFeatureOrmModule(buildConfig, buildOrmModuleProviders(buildConfig, DATABASE_PROVIDER));
    attachOwnedStoreRegistration(module, buildConfig.context, buildConfig.entities ?? [], config.ownedStore);
    return module;
  }
  if (config.ensureCreated && (config.migrateOnStart || config.runMigrationsOnStart || (config.migrations?.length ?? 0) > 0)) throw new OrmError("ensureCreated is mutually exclusive with ORM migration startup options.");
  if (config.ensureCreated && config.provider?.name === "postgres" && config.context) throw new OrmError("PostgreSQL ensureCreated requires the shared DATABASE_PROVIDER from @Infra.");
  // "Connection" mode: a provider only, no context.
  if (!config.context) {
    if (!config.provider) {
      throw new OrmError("ormModule requires a `provider` (connection) and/or a `context` (feature).");
    }
    return defineConnectionModule(config.provider, config.healthCheck !== false);
  }

  const buildConfig = config as OrmBuildConfig<TContext>;

  // Standalone: a context with its own provider value.
  if (config.provider) {
    // Only the static DbContextOptions are built eagerly here. Schema lifecycle
    // flags and migrations are read at resolve time, because an owned-store graph
    // may replace them with a container-local snapshot.
    const standaloneOptions = new DbContextOptions({
      provider: config.provider,
      entities: config.entities ?? [],
      validateOnSave: config.validateOnSave,
      executionStrategy: config.executionStrategy,
    });
    const registration = Object.freeze({});
    const providers = buildOrmModuleProviders(buildConfig, config.provider, registration, standaloneOptions);
    if (buildConfig.healthCheck !== false) {
      providers.push(buildOrmHealthCheck(config.provider));
    }
    const module = defineFeatureOrmModule(buildConfig, providers);
    attachOrmGraphContribution(module, buildConfig.context, buildConfig.entities ?? [], config, registration);
    return module;
  }

  // Feature: a context on the shared DATABASE_PROVIDER.
  // The source config remains the ordinary-only compatibility path. When an
  // owned store is present in this container, the graph compiler snapshots it
  // once and the factories below resolve that same opaque registration view.
  const registration = Object.freeze({});
  const providers = buildOrmModuleProviders(buildConfig, DATABASE_PROVIDER, registration);
  if (config.healthCheck === true) {
    providers.push(buildOrmHealthCheckFromToken(DATABASE_PROVIDER));
  }
  const module = defineFeatureOrmModule(buildConfig, providers);
  // `registration` is deliberately per ormModule call, not a token or public
  // identity. It links this factory to its container-local graph snapshot.
  attachOrmGraphContribution(module, buildConfig.context, buildConfig.entities ?? [], config, registration);
  return module;
}

export { DATABASE_PROVIDER };
