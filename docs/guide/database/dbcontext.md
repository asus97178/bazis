# `DbContext` и `DbSet`

`DbContext` — точка работы с базой: он хранит наборы сущностей,
отслеживает изменения и сохраняет их одной транзакцией. `DbSet` — набор
одной сущности: запросы к таблице и добавление, изменение, удаление.

Все примеры проверены на bazis 0.98.15 и PostgreSQL 17.

## Контекст модуля

```ts
import { DbContext } from "bazis/core/orm";

export class CatalogDbContext extends DbContext {
  readonly products = this.set(Product);
  readonly categories = this.set(Category);
}
```

```ts
@Module({
  ormBazis: { context: CatalogDbContext, entities: [Product, Category], ensureCreated: true },
  providers: [scoped(ProductsService)],
  controllers: [ProductsController],
  exports: [],
})
export class CatalogModule {}
```

`ormBazis` регистрирует контекст в DI и подключает его к общему
подключению из `@Infra` ([Подключение PostgreSQL](postgresql.md)). В
`entities` перечисляются все сущности контекста; `ensureCreated` создаёт
недостающие таблицы при запуске.

Сервис получает контекст в конструкторе, как любой другой сервис:

```ts
export class ProductsService {
  constructor(private readonly db: CatalogDbContext) {}

  async create(name: string, price: number) {
    const product = this.db.products.add(Object.assign(new Product(), { name, price }));
    await this.db.saveChanges();
    return product;
  }
}
```

## Сколько живёт контекст

Контекст — `scoped`-сервис: **один на HTTP-запрос**. Контроллер и все
сервисы в одном запросе получают один и тот же экземпляр, следующий
запрос — новый:

```text
GET /products/context → {"controller":1,"service":1}
GET /products/context → {"controller":2,"service":2}
```

Поэтому изменения, которые разные сервисы сделали в одном запросе,
сохраняет один `saveChanges()`, а данные одного запроса не смешиваются с
другим.

Внедрить контекст в `singleton` нельзя — приложение не запустится:

```text
Singleton "PriceCache" depends on scoped "CatalogDbContext". A scoped service lives for one request or scope:
make "PriceCache" scoped too, or inject ServiceProvider and resolve "CatalogDbContext" in a scope you create (provider.createScope()).
```

### Вне запроса

В фоновой службе запроса нет — создайте область на каждую единицу
работы, и в ней будет свой контекст:

```ts
@Background({ intervalMs: 60_000 })
export class CatalogStats extends PeriodicBackgroundService {
  constructor(private readonly provider: ServiceProvider) { super(); }

  protected override async tick(): Promise<void> {
    const scope = this.provider.createScope();
    try {
      const count = await scope.resolve(CatalogDbContext).products.count();
      // ...
    } finally {
      await scope.dispose();
    }
  }
}
```

Каждый тик получает новый контекст. Подробнее — в главе
[Жизненный цикл](../fundamentals/lifecycle.md#scoped-сервисы-в-фоновой-службе).

## Несколько модулей

У каждого модуля с данными свой контекст со своими сущностями; все они
работают через одно подключение. Чтобы другой модуль мог пользоваться
контекстом, его экспортируют:

```ts
@Module({ ormBazis: { context: CatalogDbContext, entities: [Product] }, exports: [CatalogDbContext] })
export class CatalogModule {}

@Module({ imports: [CatalogModule], ormBazis: { context: OrdersDbContext, entities: [Order] }, providers: [scoped(OrdersService)] })
export class OrdersModule {}

export class OrdersService {
  constructor(private readonly orders: OrdersDbContext, private readonly catalog: CatalogDbContext) {}
}
```

Без `exports` приложение не запустится и назовёт модуль, который нужно
поправить:

```text
"OrdersService" depends on "CatalogDbContext", which its import "CatalogModule" receives from its own imports
but does not export. Add it to the exports of "CatalogModule".
```

> [!NOTE]
> Такое сообщение — с версии 0.98.15. Раньше оно называло внутренний
> модуль `ormBazis` (`module#10`) и советовало импортировать его.

Экспорт контекста открывает другому модулю **все** таблицы контекста.
Часто лучше экспортировать сервис (`ProductsService`), а контекст оставить
внутри модуля — см. [Инкапсуляцию](../fundamentals/encapsulation.md).

## `DbSet`

| Метод | Что делает |
| --- | --- |
| `add(entity)`, `addRange([...])` | Отметить для вставки |
| `update(entity)` | Отметить как изменённую целиком |
| `remove(entity)` | Отметить для удаления |
| `attach(entity)` | Начать отслеживать существующую строку без изменений |
| `find(key)` | Найти по ключу; составной — объектом `{ orderId, lineNo }` |
| `findForUpdate(key)` | Найти и заблокировать строку (`FOR UPDATE`) до конца транзакции |
| `where`, `orderBy`, `take`, `toList`, `count`, … | Запросы — см. главу «Запросы» |

`add`, `update`, `remove` ничего не отправляют в базу — изменения уходят
одним `saveChanges()`:

```ts
this.db.products.add(tea);
this.db.products.remove(oldTea);
await this.db.saveChanges();   // INSERT и DELETE в одной транзакции
```

Те же `add`, `update`, `remove`, `attach` есть у самого контекста — он
сам находит набор по классу объекта: `this.db.add(product)`.

## Сырой SQL

`database` контекста выполняет SQL, когда ORM не хватает:

```ts
const rows = await this.db.database.querySqlRaw(
  "SELECT name, price FROM products WHERE price >= {0} ORDER BY id",
  minPrice,
);
await this.db.database.executeSqlRaw("UPDATE products SET price = price * {0}", 1.1);
```

`{0}`, `{1}` — параметры: значения уходят в базу отдельно от текста
запроса, подставить в них SQL нельзя. Строки приходят как есть, без
преобразований ORM:

```json
[{"name":"Tea","price":"120"}]
```

Столбец `type: "integer"` в PostgreSQL — `bigint`, и драйвер отдаёт его
**строкой**, чтобы не терять точность больших чисел. Через `DbSet` то же
поле приходит числом. В сыром SQL приводите тип сами: `price::int` в
запросе или `Number(row.price)` в коде.

## Дальше

- [Сущности и ключи](entities.md)
- [Жизненный цикл](../fundamentals/lifecycle.md)
- Запросы *(в работе)*
- Сохранение и отслеживание изменений *(в работе)*
