import type { DbContext } from "./DbContext";
import type { DbContextOptions } from "./DbContextOptions";

type ContextClass<TContext extends DbContext> = new (options: DbContextOptions) => TContext;

/**
 * Context factory for scenarios outside a DI scope (background tasks, scripts,
 * parallel processing). Each `create()` returns a new context with its own
 * ChangeTracker on top of the shared provider/model.
 *
 * ```ts
 * const factory = new DbContextFactory(AppDbContext, options);
 * const ctx = factory.create();
 * ```
 */
export class DbContextFactory<TContext extends DbContext> {
  constructor(
    private readonly contextType: ContextClass<TContext>,
    private readonly options: DbContextOptions,
  ) {}

  create(): TContext {
    return new this.contextType(this.options);
  }
}
