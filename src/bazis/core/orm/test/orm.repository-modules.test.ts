import { describe, expect, test } from "bun:test";
import { DI, Module, ModuleEncapsulationError, createContainer, namedDependency } from "@/core/di";
import { Column, DbContext, Entity, IRepository, Key, ormModule, repositoryFor, type DatabaseProvider } from "@/core/orm";
import { redactSensitiveText } from "@/library/redaction";

@Entity({ table: "repo_modules_products" })
class Product { @Key() id = 0; @Column({ type: "text" }) name = ""; }
@Entity({ table: "repo_modules_categories" })
class Category { @Key() id = 0; @Column({ type: "text" }) name = ""; }
class CatalogDbContext extends DbContext {}

const provider = { name: "test", dialect: { name: "test" }, query: async () => [], execute: async () => ({ changes: 0, lastInsertId: 0 }), transaction: async <T>(work: never) => work as T, ping: async () => true, close: async () => undefined, introspect: async () => ({ tables: new Map() }) } as unknown as DatabaseProvider;
const ConnectionModule = ormModule({ provider, healthCheck: false });

class OrdersService { constructor(readonly products: IRepository<Product>) {} }
class ReportsService { constructor(readonly categories: IRepository<Category>) {} }
const orders = DI.scoped(DI.classProvider(OrdersService, OrdersService, [namedDependency<IRepository<Product>>("IRepository<Product>")] as const));
const reports = DI.scoped(DI.classProvider(ReportsService, ReportsService, [namedDependency<IRepository<Category>>("IRepository<Category>")] as const));

function catalog(exports: unknown[], registerRepositories = true) {
  @Module({ ormBazis: { context: CatalogDbContext, entities: [Product, Category], registerRepositories }, exports: exports as never })
  class CatalogModule {}
  return CatalogModule;
}

function failure(build: () => unknown): string {
  try { build(); } catch (error) { return redactSensitiveText((error as Error).message); }
  throw new Error("expected a failure");
}

describe("repositories across modules", () => {
  test("an imported module that does not export the repositories is named, not its inner ormBazis module", () => {
    const CatalogModule = catalog([]);
    @Module({ imports: [CatalogModule], providers: [orders], exports: [] })
    class OrdersModule {}
    @Module({ imports: [ConnectionModule, OrdersModule], exports: [] })
    class AppModule {}
    const message = failure(() => createContainer(AppModule));
    expect(message).toContain(`Module "OrdersModule": "OrdersService" depends on "IRepository<Product>", which its import "CatalogModule" receives from its own imports but does not export. Add IRepository (or only IRepository<Product>) to the exports of "CatalogModule".`);
    expect(message).not.toContain("module#");
  });

  test("a module that exports the repositories but is not imported is named", () => {
    const CatalogModule = catalog([IRepository]);
    @Module({ providers: [orders], exports: [] })
    class OrdersModule {}
    @Module({ imports: [ConnectionModule, CatalogModule, OrdersModule], exports: [] })
    class AppModule {}
    expect(failure(() => createContainer(AppModule))).toContain(`Module "OrdersModule": "OrdersService" depends on "IRepository<Product>", which module "CatalogModule" exports, but "OrdersModule" does not list "CatalogModule" in its imports. Add "CatalogModule" to the imports of "OrdersModule".`);
  });

  test("an open root module (no exports, like AppModule under the kernel) is not offered as the exporter", () => {
    // A module without exports passes on everything it imports, so the
    // application root "exported" the repositories too and was named first.
    const CatalogModule = catalog([repositoryFor(Product)]);
    @Module({ providers: [orders], exports: [] })
    class OrdersModule {}
    @Module({ imports: [ConnectionModule, OrdersModule, CatalogModule] })
    class AppModule {}
    @Module({ imports: [AppModule] })
    class KernelRootModule {}
    const message = failure(() => createContainer(KernelRootModule));
    expect(message).toContain(`which module "CatalogModule" exports, but "OrdersModule" does not list "CatalogModule" in its imports. Add "CatalogModule" to the imports of "OrdersModule".`);
    expect(message).not.toContain("KernelRootModule");
    expect(message).not.toContain(`"AppModule"`);
  });

  test("a module can export the repository of one entity only", () => {
    const CatalogModule = catalog([repositoryFor(Product)]);
    @Module({ imports: [CatalogModule], providers: [orders], exports: [] })
    class OrdersModule {}
    @Module({ imports: [ConnectionModule, OrdersModule], exports: [] })
    class AppModule {}
    const container = createContainer(AppModule);
    expect(container.createScope().resolve(OrdersService).products.dbSet).toBeDefined();

    @Module({ imports: [CatalogModule], providers: [reports], exports: [] })
    class ReportsModule {}
    @Module({ imports: [ConnectionModule, ReportsModule], exports: [] })
    class ReportsApp {}
    expect(() => createContainer(ReportsApp)).toThrow(ModuleEncapsulationError);
  });

  test("a missing repository explains where repositories come from", () => {
    const CatalogModule = catalog([], false);
    @Module({ imports: [CatalogModule], providers: [orders], exports: [] })
    class OrdersModule {}
    @Module({ imports: [ConnectionModule, OrdersModule], exports: [] })
    class AppModule {}
    expect(failure(() => createContainer(AppModule, { validateOnBuild: true }).createScope().resolve(OrdersService))).toContain(`Missing dependency "IRepository<Product>" for "OrdersService". Repositories are registered by ormBazis for the entities of its context: add Product to the entities of an ormBazis module and keep registerRepositories on (the default), or inject that module's DbContext instead.`);
  });
});

