import { DI, type DiRegistrar } from "../di";
import { Repository, type DbContext, type DbContextOptions } from "../../library/orm";
import { repositoryFor } from "./repository";

type EntityClass = new () => object;
type ContextClass<TContext extends DbContext> = new (options: DbContextOptions) => TContext;

/**
 * Registers a scoped `IRepository<T>` for each context entity and the
 * open generic family (for encapsulation / `IRepository.of(Entity)`).
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
