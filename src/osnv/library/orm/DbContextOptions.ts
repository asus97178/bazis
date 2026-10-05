import type { ExecutionStrategyOptions } from "./Saving/ExecutionStrategy";
import { OrmModel } from "./Metadata/OrmModel";
import type { DatabaseProvider } from "./Providers/types";

type EntityClass = new () => object;

export interface DbContextOptionsConfig {
  readonly provider: DatabaseProvider;
  readonly entities: readonly EntityClass[];
  /** Валидировать сущности перед SaveChanges (по умолчанию true). */
  readonly validateOnSave?: boolean;
  /** Повторы при transient-ошибках БД (`EnableRetryOnFailure`). */
  readonly executionStrategy?: ExecutionStrategyOptions;
}

/**
 * Иммутабельные опции контекста: провайдер БД, скомпилированная модель и флаги
 * поведения. Создаются один раз (модель строится из `entities`) и
 * переиспользуются всеми scoped-экземплярами `DbContext`.
 */
export class DbContextOptions {
  readonly provider: DatabaseProvider;
  readonly model: OrmModel;
  readonly validateOnSave: boolean;
  readonly executionStrategy?: ExecutionStrategyOptions;

  constructor(config: DbContextOptionsConfig) {
    this.provider = config.provider;
    this.model = new OrmModel(config.entities);
    this.validateOnSave = config.validateOnSave ?? true;
    this.executionStrategy = config.executionStrategy;
  }
}
