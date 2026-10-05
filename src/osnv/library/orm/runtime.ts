import type { OrmModel } from "./Metadata/OrmModel";
import type { DatabaseProvider } from "./Providers/types";
import type { ChangeTracker } from "./Tracking/ChangeTracker";

/**
 * Internal runtime that `DbContext` passes to `DbSet`. Kept in a separate
 * module to break import cycles between the context, the set and the tracker.
 */
export interface DbContextRuntime {
  readonly provider: DatabaseProvider;
  readonly models: OrmModel;
  readonly tracker: ChangeTracker;
  readonly runImmediateOperation: <T>(operation: () => T | Promise<T>) => Promise<T>;
}
