import type { DbContext } from "./DbContext";
import type { DbContextOptions } from "./DbContextOptions";

type ContextClass<TContext extends DbContext> = new (options: DbContextOptions) => TContext;

/**
 * Фабрика контекстов для сценариев вне DI-скоупа (фоновые задачи, скрипты,
 * параллельная обработка). Каждый `create()` — новый контекст со своим
 * ChangeTracker поверх общего провайдера/модели.
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
