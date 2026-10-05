import type { OrmModel } from "./Metadata/OrmModel";
import type { DatabaseProvider } from "./Providers/types";
import type { ChangeTracker } from "./Tracking/ChangeTracker";

/**
 * Внутренний рантайм, который `DbContext` передаёт в `DbSet`. Вынесен в
 * отдельный модуль, чтобы разорвать циклы импортов между контекстом, набором
 * и трекером.
 */
export interface DbContextRuntime {
  readonly provider: DatabaseProvider;
  readonly models: OrmModel;
  readonly tracker: ChangeTracker;
  readonly runImmediateOperation: <T>(operation: () => T | Promise<T>) => Promise<T>;
}
