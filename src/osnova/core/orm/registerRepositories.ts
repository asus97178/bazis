import { DI, type DiRegistrar } from "../di";
import { Repository, type DbContext, type DbContextOptions } from "../../library/orm";
import { IRepository, repositoryFor } from "./repository";

type EntityClass = new () => object;
type ContextClass<TContext extends DbContext> = new (options: DbContextOptions) => TContext;

/**
 * Регистрирует scoped `IRepository<T>` для каждой сущности контекста и
 * open generic family (для encapsulation / `IRepository.of(Entity)`).
 */
export function registerRepositories<TContext extends DbContext>(
  di: DiRegistrar,
  contextClass: ContextClass<TContext>,
  entities: readonly EntityClass[],
): void {
  for (const EntityClass of entities) {
    di.scoped(
      DI.factoryProvider(
        repositoryFor(EntityClass),
        [contextClass],
        (context: TContext) => new Repository(context, EntityClass),
      ),
    );
  }

}
