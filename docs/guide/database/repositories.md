# Репозитории

Репозиторий `IRepository<T>` — тонкая обёртка над `DbSet<T>` одной
сущности. `ormBazis` регистрирует его сам для каждой сущности контекста:
объявлять ничего не нужно.

Все примеры проверены на bazis 0.98.22 и PostgreSQL 17.

> [!TIP]
> Для нового кода bazis рекомендует внедрять сам `DbContext`
> ([`DbContext` и `DbSet`](dbcontext.md)): так видно, какие таблицы трогает
> сервис и где граница сохранения. Репозиторий удобен, когда сервису нужна
> одна сущность из чужого модуля, или в тесте, где проще подменить одну
> сущность, чем весь контекст.

## Внедрение

```ts
import { IRepository } from "bazis/core/orm";

export class ProductsService {
  constructor(
    private readonly products: IRepository<Product>,
    private readonly categories: IRepository<Category>,
  ) {}

  cheap() {
    return this.products.query().where((p) => p.price.lt(200)).orderBy((p) => p.id).toList();
  }
}

@Module({
  ormBazis: { context: CatalogDbContext, entities: [Category, Product], ensureCreated: true },
  providers: [scoped(ProductsService)],
})
export class CatalogModule {}
```

Тип параметра `IRepository<Product>` — это и есть объявление зависимости:
codegen подставит репозиторий нужной сущности.

## Что умеет

| Член | Что делает |
| --- | --- |
| `query()`, `dbSet` | `DbSet<T>` со всеми [запросами](queries.md): `where`, `orderBy`, `include`, `count`… |
| `find(key)` | Сущность по ключу или `null` |
| `add`, `addRange`, `update`, `remove`, `attach` | Как у `DbSet` ([сохранение](saving.md)) |
| `stateOf(entity)` | `EntityState` сущности |
| `saveChanges()` | Сохраняет изменения **всего контекста** |
| `changeTracker`, `database` | Трекер и `DatabaseFacade` контекста |

## Один контекст на запрос

Репозитории одного контекста в одном запросе работают с **одним**
экземпляром `DbContext` и общим трекером. Поэтому `saveChanges()`
сохраняет всё, что изменено в контексте, а не только свою сущность:

```ts
this.categories.add(Object.assign(new Category(), { name: "Coffee" }));
this.products.add(Object.assign(new Product(), { name: "Latte", price: 300 }));
await this.products.saveChanges();   // 2 — сохранены и категория, и товар
```

Если операция затрагивает несколько сущностей, явная граница читается
лучше: внедрите `CatalogDbContext` и вызовите `db.saveChanges()`.

## Из другого модуля

Модуль с `ormBazis` по умолчанию держит свои репозитории при себе. Чтобы
`OrdersModule` получил товары каталога, `CatalogModule` экспортирует их, а
`OrdersModule` импортирует `CatalogModule`:

```ts
import { IRepository, repositoryFor } from "bazis/core/orm";

@Module({
  ormBazis: { context: CatalogDbContext, entities: [Category, Product] },
  exports: [repositoryFor(Product)],   // только товары
  // exports: [IRepository],           // репозитории всех сущностей каталога
})
export class CatalogModule {}

export class OrdersService {
  constructor(private readonly products: IRepository<Product>) {}
}

@Module({ imports: [CatalogModule], providers: [scoped(OrdersService)] })
export class OrdersModule {}
```

С `repositoryFor(Product)` модулю заказов не видны категории: попытка
внедрить `IRepository<Category>` остановит запуск.

Если экспорт или импорт забыт, ошибка называет модуль, который надо
поправить:

```text
Module "OrdersModule": "OrdersService" depends on "IRepository<Product>", which its import "CatalogModule"
receives from its own imports but does not export. Add IRepository (or only IRepository<Product>) to the
exports of "CatalogModule".
```

```text
Module "OrdersModule": "OrdersService" depends on "IRepository<Product>", which module "CatalogModule"
exports, but "OrdersModule" does not list "CatalogModule" in its imports. Add "CatalogModule" to the
imports of "OrdersModule".
```

> [!NOTE]
> Точечный экспорт `repositoryFor(Product)` и эти сообщения — с версии
> 0.98.22. Раньше работал только `exports: [IRepository]`, а ошибка
> указывала на внутренний модуль `module#10`, который создаёт `ormBazis`.

## Выключить

```ts
ormBazis: { context: CatalogDbContext, entities: [Category, Product], registerRepositories: false }
```

Тогда внедрить репозиторий нельзя:

```text
No provider token found for named dependency "IRepository<Product>". Repositories are registered by ormBazis
for the entities of its context: add Product to the entities of an ormBazis module and keep
registerRepositories on (the default), or inject that module's DbContext instead.
```

Та же ошибка будет для сущности, которой нет ни в одном `ormBazis`.

## Подмена в тестах

Репозиторий подменяется, как любая зависимость
([Тестирование](../fundamentals/testing.md)). Токен — `repositoryFor(Product)`:

```ts
import { DI } from "bazis/core/di";
import { repositoryFor, type IRepository } from "bazis/core/orm";
import { startTestApp } from "bazis/core/testing";

test("orders count products through a fake repository", async () => {
  const fake = { query: () => ({ count: async () => 42 }) } as unknown as IRepository<Product>;
  const app = await startTestApp(AppModule, {
    infra: AppInfra,
    http: false,
    overrides: [DI.scoped(DI.valueProvider(repositoryFor(Product), fake))],
  });
  try {
    expect(await app.container.createScope().resolve(OrdersService).count()).toBe(42);
  } finally {
    await app.stop();
  }
});
```

## Дальше

- [`DbContext` и `DbSet`](dbcontext.md)
- [Запросы](queries.md)
- [Сохранение и отслеживание изменений](saving.md)
- [Инкапсуляция модулей](../fundamentals/encapsulation.md)
