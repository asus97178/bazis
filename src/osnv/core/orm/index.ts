// Слой интеграции ORM с фреймворком (DI/kernel). Чистый движок —
// `@/library/orm`; здесь к нему добавляются DI-модуль, токены, lifecycle
// и health-check. Для удобства движок реэкспортируется целиком.
export * from "../../library/orm";

export { ormModule, type OrmModuleConfig } from "./ormModule";
export { ormOsnvConnect, type PostgresOrmConfigShape } from "./databaseConnector";
export { DATABASE_PROVIDER } from "./DATABASE_PROVIDER";
export { OrmConnectionLifecycle, OrmLifecycle, OrmProviderReadyLifecycle } from "./OrmLifecycle";
export { IRepository, repositoryFor } from "./repository";
export { registerRepositories } from "./registerRepositories";
export { paginate, type PageResult } from "./listQuery";

import { registerModuleMetadataExpander, type OsnvModuleRef } from "../di";
import { OrmOwnedStoreAdmissionError, type DbContext } from "../../library/orm";
import { registerRepositoryEncapsulationHook } from "./encapsulationHook";
import { ormModule, type OrmModuleConfig } from "./ormModule";
import { readOwnedStoreRegistration, revalidateOwnedStoreRegistration } from "./ownedStoreContributions";

registerRepositoryEncapsulationHook();

/**
 * Declarative `ormOsnv` key for `@Module(...)`: a shorthand for
 * `imports: [ormModule(config)]`. Accepts one config or an array. The DI core
 * stays unaware of the ORM — this expander is registered here (side effect of
 * importing `@/core/orm`) and run by `createContainer`.
 *
 * ```ts
 * @Module({ ormOsnv: { context: UsersDbContext, entities: [User], ensureCreated: true } })
 * class UsersModule {}
 * ```
 */
// Augment the declaring file, not the "../di" re-export: re-export targets
// depend on program file order and silently stop merging in some projects.
declare module "../di/module/types/OsnvModule" {
  interface OsnvModuleMetadata {
    readonly ormOsnv?: OrmModuleConfig<DbContext> | readonly OrmModuleConfig<DbContext>[];
  }
}

interface CachedDeclarativeOrm {
  readonly config: object;
  readonly module: OsnvModuleRef;
  readonly registration?: ReturnType<typeof readOwnedStoreRegistration>;
  readonly context: unknown;
  readonly entities: readonly unknown[] | undefined;
  readonly ownedStore: unknown;
  readonly ensureCreated: boolean | undefined;
  readonly migrateOnStart: boolean | undefined;
  readonly runMigrationsOnStart: boolean | undefined;
  readonly migrations: readonly unknown[] | undefined;
}
const declarativeCache = new WeakMap<object, readonly CachedDeclarativeOrm[]>();

function declaredOwnedStore(config: OrmModuleConfig<DbContext>): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(config, "ownedStore");
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_IDENTITY_MISMATCH");
  return descriptor.value;
}

registerModuleMetadataExpander((metadata): readonly OsnvModuleRef[] => {
  const orm = (metadata as { ormOsnv?: OrmModuleConfig<DbContext> | readonly OrmModuleConfig<DbContext>[] }).ormOsnv;
  if (orm === undefined) {
    return [];
  }
  const configs = Array.isArray(orm) ? orm : [orm];
  const owned = configs.map((config) => declaredOwnedStore(config));
  const cached = declarativeCache.get(metadata as object);
  if (cached) {
    if (cached.length !== configs.length || cached.some((entry, index) => entry.config !== configs[index])) throw new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_IDENTITY_MISMATCH");
    for (let index = 0; index < cached.length; index += 1) {
      const entry = cached[index]!;
      const config = configs[index]!;
      if (config.context !== entry.context
        || config.entities?.length !== entry.entities?.length
        || config.entities?.some((entity: unknown, entityIndex: number) => entity !== entry.entities?.[entityIndex])
        || owned[index] !== entry.ownedStore
        || config.ensureCreated !== entry.ensureCreated
        || config.migrateOnStart !== entry.migrateOnStart
        || config.runMigrationsOnStart !== entry.runMigrationsOnStart
        || config.migrations !== entry.migrations) {
        throw new OrmOwnedStoreAdmissionError("ORM_OWNED_STORE_IDENTITY_MISMATCH", "ORM_OWNED_STORE_IDENTITY_MISMATCH");
      }
      if (entry.registration) revalidateOwnedStoreRegistration(entry.registration);
    }
    return cached.map((entry) => entry.module);
  }
  const created = configs.map((config, index) => {
    const module = ormModule(config);
    return Object.freeze({ config: config as object, module, registration: readOwnedStoreRegistration(module), context: config.context, entities: config.entities === undefined ? undefined : Object.freeze([...config.entities]), ownedStore: owned[index], ensureCreated: config.ensureCreated, migrateOnStart: config.migrateOnStart, runMigrationsOnStart: config.runMigrationsOnStart, migrations: config.migrations });
  });
  if (owned.some((value) => value !== undefined)) declarativeCache.set(metadata as object, Object.freeze(created));
  return created.map((entry) => entry.module);
});
