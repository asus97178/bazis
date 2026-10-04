import { DI, HOSTED_SERVICE, singletonValue, type OsnovaModuleRef, type ProviderDefinition } from "../di";
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
 * Единая форма регистрации ORM. Одна функция — три сценария по тому, какие
 * поля переданы:
 *
 * - **Соединение** (`{ provider }`, без `context`) — глобальный модуль, который
 *   публикует общий {@link DATABASE_PROVIDER}. Создаётся один раз в корне.
 * - **Feature** (`{ context, entities }`, без `provider`) — контекст и его
 *   репозитории, подключённые к общему {@link DATABASE_PROVIDER}.
 * - **Standalone** (`{ context, entities, provider }`) — контекст с собственным
 *   провайдером (тесты, изолированные модули).
 *
 * Провайдер — это значение (`postgres(...)`), как infra-коннектор
 * в кэше: инфраструктура конфигурируется значением, а не вложенным модулем.
 */
export interface OrmModuleConfig<TContext extends DbContext> {
  /** Класс контекста (наследник DbContext). Опускается в режиме «соединение». */
  readonly context?: ContextClass<TContext>;
  /** Сущности, замапленные этим контекстом. */
  readonly entities?: readonly EntityClass[];
  /**
   * Провайдер-значение БД (`postgres(...)`). Без него контекст
   * подключается к общему {@link DATABASE_PROVIDER} (feature-режим).
   */
  readonly provider?: DatabaseProvider;
  /** Валидировать сущности перед SaveChanges (по умолчанию true). */
  readonly validateOnSave?: boolean;
  /** Создавать схему на старте (`CREATE TABLE IF NOT EXISTS`). По умолчанию false. */
  readonly ensureCreated?: boolean;
  /**
   * Запускать аддитивную авто-миграцию на старте для сущностей с
   * `@Entity({ migrate: true })`. По умолчанию false.
   */
  readonly migrateOnStart?: boolean;
  /** Версионированные миграции (compile-safe массив). История в `__OsnovaMigrations`. */
  readonly migrations?: readonly Migration[];
  /** Запускать `migrateVersioned` на старте (по умолчанию false). */
  readonly runMigrationsOnStart?: boolean;
  /** Повторы при transient-ошибках БД в SaveChanges. */
  readonly executionStrategy?: DbContextOptionsConfig["executionStrategy"];
  /**
   * Регистрировать health-check соединения. По умолчанию: включён для режимов
   * «соединение» и «standalone», выключен для feature (его включает корень).
   */
  readonly healthCheck?: boolean;
  /** Регистрировать scoped `IRepository<T>` для сущностей (по умолчанию true). */
  readonly registerRepositories?: boolean;
  /** Модули с зависимостями контекста. */
  readonly imports?: readonly OsnovaModuleRef[];
  /** Approved owned PostgreSQL store descriptor; admission is owned by the core lifecycle. */
  readonly ownedStore?: import("../../library/orm").OrmOwnedStoreDefinitionV1;
}

function defineFeatureOrmModule<TContext extends DbContext>(
  config: OrmBuildConfig<TContext>,
  providers: ProviderDefinition[],
): OsnovaModuleRef {
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

function defineConnectionModule(provider: DatabaseProvider, healthCheck: boolean): OsnovaModuleRef {
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

/** Единая точка регистрации ORM (см. {@link OrmModuleConfig}). */
export function ormModule<TContext extends DbContext>(config: OrmModuleConfig<TContext>): OsnovaModuleRef {
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
  // Режим «соединение»: только провайдер, без контекста.
  if (!config.context) {
    if (!config.provider) {
      throw new OrmError("ormModule requires a `provider` (connection) and/or a `context` (feature).");
    }
    return defineConnectionModule(config.provider, config.healthCheck !== false);
  }

  const buildConfig = config as OrmBuildConfig<TContext>;

  // Standalone: контекст со своим провайдером-значением.
  if (config.provider) {
    // Pre-D standalone construction eagerly captured only DbContextOptions.
    // Lifecycle flags and migrations deliberately stayed resolve-time until an
    // owned graph supplies a container-local effective snapshot.
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

  // Feature: контекст на общем DATABASE_PROVIDER.
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
