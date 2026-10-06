import type { ExecutionStrategyOptions } from "./Saving/ExecutionStrategy";
import { OrmModel } from "./Metadata/OrmModel";
import type { DatabaseProvider } from "./Providers/types";

type EntityClass = new () => object;

export interface DbContextOptionsConfig {
  readonly provider: DatabaseProvider;
  readonly entities: readonly EntityClass[];
  /** Validate entities before SaveChanges (default true). */
  readonly validateOnSave?: boolean;
  /** Retries on transient database errors (`EnableRetryOnFailure`). */
  readonly executionStrategy?: ExecutionStrategyOptions;
}

/**
 * Immutable context options: the database provider, the compiled model and
 * behavior flags. Created once (the model is built from `entities`) and reused
 * by all scoped `DbContext` instances.
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
