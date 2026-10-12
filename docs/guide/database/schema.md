# Управление схемой

Таблицы в базе должны совпадать с сущностями. bazis умеет создавать и
обновлять их сам при запуске. Режим задаётся в `ormBazis` модуля.

Все примеры проверены на bazis 0.98.21 и PostgreSQL 17.

| Режим | Что делает при запуске | Когда брать |
| --- | --- | --- |
| `ensureCreated: true` | Создаёт недостающее и **проверяет**, что схема совпадает с моделью. Опасное изменение не делает и не даёт запуститься | По умолчанию |
| `ensureCreated` + `migrations` | То же, а изменения, которые нельзя сделать автоматически, выполняет написанными тобой миграциями | Когда понадобился первый `ALTER` |
| `migrateOnStart: true` | Только добавляет недостающее, остальное оставляет и пишет предупреждение | Прототип, где строгая проверка мешает |
| `migrations` без `ensureCreated` | Выполняет только твои миграции, схему не проверяет | Схема целиком под твоим контролем |

Во всём приложении нужен **один** режим: `ensureCreated` (с миграциями или
без) во всех модулях, либо `migrateOnStart`/`migrations` во всех.

## `ensureCreated`

```ts
@Module({
  ormBazis: { context: CatalogDbContext, entities: [Product], ensureCreated: true },
})
export class CatalogModule {}
```

Первый запуск на пустой базе:

```text
[orm:schema] applied 1 operation(s): create table products
```

Следующие запуски ничего не меняют и ничего не пишут.

### Что добавляется само

Безопасные изменения `ensureCreated` применяет сам:

- новая таблица;
- новый столбец, допускающий `NULL`;
- новый обязательный столбец со значением по умолчанию в базе
  (`@Column({ default: "new" }) @Required()`), которое получат старые строки;
- индекс, `@Check`, внешний ключ.

Добавили в `Product` необязательное поле с уникальным индексом:

```ts
@Index({ unique: true }) @Column({ type: "text" }) sku: string | null = null;
```

```text
[orm:schema] applied 2 operation(s): add column products.sku, create unique index ix_products_sku on products (sku)
```

Если в существующих строках есть дубли, уникальный индекс создать
нельзя. Запуск остановится, а ошибка назовёт индекс и код PostgreSQL;
значения строк в текст не попадают:

```text
SchemaAdmissionError [ORM_SCHEMA_ADDITIVE_DATA_VIOLATION]: Existing PostgreSQL data violates the declared
additive schema change: create unique index ix_products_sku on products (sku) failed with PostgreSQL 23505:
could not create unique index "ix_products_sku". Fix the data, then start again.
```

### Что требует миграции

Смену типа, удаление или переименование столбца, обязательный столбец без
значения по умолчанию `ensureCreated` не делает: на данных это может
потерять информацию или упасть. Приложение не запустится, а ошибка
перечислит все расхождения:

```text
[bazis] application failed: SchemaMigrationRequiredError [ORM_SCHEMA_MIGRATION_REQUIRED]: PostgreSQL schema change requires an explicit migration.
- Table "public"."products", object "price": column type differs (column.type); expected (ORM): "real"; actual (database): "integer".
- Table "public"."products", object "sku": column exists in the database but is absent from the ORM model (column.unexpected); expected (ORM): absent; actual (database): present.
Check the application version and target database. Align the ORM model and database schema; apply an explicit migration if a database change is intended (with ensureCreated: add it to the module's migrations with runMigrationsOnStart: true).
```

Так ошибку видно до первого запроса, а не на нём. Следующий раздел —
что делать дальше.

## `ensureCreated` + миграции

Миграция — шаг с уникальным `id` и функцией `up` (и, по желанию, `down`
для отката):

```ts
import type { Migration } from "bazis/core/orm";

const migrations: Migration[] = [
  {
    id: "20261010_01_price_real",
    up: async (db) => { await db.execute("ALTER TABLE products ALTER COLUMN price TYPE double precision"); },
    down: async (db) => { await db.execute("ALTER TABLE products ALTER COLUMN price TYPE bigint"); },
  },
];

@Module({
  ormBazis: { context: CatalogDbContext, entities: [Product], ensureCreated: true, migrations, runMigrationsOnStart: true },
})
export class CatalogModule {}
```

Что происходит при запуске, зависит от базы.

**Существующая база.** Сначала выполняются новые миграции, потом
`ensureCreated` добавляет недостающее и проверяет результат:

```text
[orm:migrations] applied: 20261010_01_price_real
```

**Новая база** (свежий стенд, тест, ноутбук нового разработчика). Таблиц
ещё нет, и `ALTER` упал бы. Поэтому `ensureCreated` создаёт таблицы сразу
в итоговом виде, а миграции **только записываются** в историю как
выполненные:

```text
[orm:schema] applied 1 operation(s): create table products
[orm:migrations] baseline: the schema was created from the model, recorded as applied without running: 20261010_01_price_real
```

Правила для миграций в этом режиме:

- Миграция описывает переход **существующей** базы: `ALTER`,
  переименование, перенос данных. Новые таблицы и столбцы, которые
  `ensureCreated` может добавить сам, в миграцию писать не нужно.
- **Начальные данные не кладите в миграции.** На новой базе миграция не
  выполнится, и справочник останется пустым. Заполняйте его кодом при
  запуске, например через [`insertIfAbsent`](immediate.md#вставить-если-такой-ещё-нет).
- Каждая миграция выполняется в своей транзакции. Упавшая откатывается
  целиком, и запуск останавливается:

  ```text
  [bazis] application failed: OrmError: Migration "20261010_03_bad" failed and was rolled back: PostgresError: relation "nope" does not exist
  Caused by: PostgresError [ERR_POSTGRES_SERVER_ERROR, 42P01]: relation "nope" does not exist
  ```

- История лежит в таблице `__BazisMigrations` (`MigrationId`, `AppliedAt`).
  Выполненную миграцию не меняйте: исправление — новая миграция с новым `id`.
- Миграции выполняются **в порядке массива**, откат идёт в обратном
  порядке применения. `id` удобно начинать с даты:
  `20261010_01_price_real`.
- Параметры в `db.execute` — `{0}` или `$1`:
  `db.execute("UPDATE tasks SET status = {0} WHERE id = {1}", "done", 7)`.

Несколько экземпляров приложения стартуют безопасно: вся
последовательность идёт под блокировкой, миграция выполнится один раз.

### Откат

Отдельной команды для отката нет. Его вызывают из кода, например в
служебном скрипте:

```ts
const result = await db.database.rollbackVersioned(migrations);       // последняя
// { applied: [], rolledBack: ["20261010_01_price_real"] }
await db.database.rollbackVersioned(migrations, 2);                    // две последние
```

Без `down` откат невозможен:

```text
Error: Migration "20261010_01_tasks_done" has no down() method.
```

## `migrateOnStart`

```ts
ormBazis: { context: CatalogDbContext, entities: [Product], migrateOnStart: true }
```

Добавляет недостающие таблицы, столбцы и индексы:

```text
[orm:migrate] applied 2 operation(s): add column products.sku, create index ix_products_sku
```

Остальное оставляет как есть и предупреждает. Приложение при этом
**запускается**:

```text
[orm:migrate] table "products": column "price" is integer in the database but real in the model (left untouched; change it with an explicit migration).
[orm:migrate] table "products": column "sku" exists in the database but not in the model (left untouched; drop it with an explicit migration).
```

Предупреждения легко пропустить, а модель тем временем разойдётся с
базой. Поэтому по умолчанию лучше `ensureCreated`.

## Несколько модулей

У каждой таблицы один хозяин — контекст, который её создаёт. Если две
сущности разных контекстов указывают на одну таблицу:

```text
SchemaAdmissionError [ORM_SCHEMA_OWNERSHIP_CONFLICT]: Schema admission table ownership conflicts: table public.products
is created by both CatalogDbContext and OrdersDbContext with ensureCreated. One context must own the table:
remove the entity from the other context and refer to it by a plain id column.
```

Внешний ключ в базе может указывать только на сущность **своего**
контекста. Заказ из модуля Orders ссылается на товар из Catalog обычным
столбцом, без `@ManyToOne`:

```ts
@Entity({ table: "orders" })
export class Order {
  @Key() id = 0;
  @Column({ type: "integer" }) productId = 0;   // id товара из CatalogModule
}
```

С навигацией на чужую сущность запуск остановится:

```text
SchemaAdmissionError [ORM_SCHEMA_CROSS_UNIT_FOREIGN_KEY]: Entity "Order" has a foreign key (productId) to "Product",
which is not an entity of the same DbContext. A database foreign key can only point to an entity of the same context:
keep productId as a plain column without @ManyToOne, or map both entities in one context.
```

Режимы схемы в разных модулях смешивать нельзя:

```text
SchemaAdmissionError [ORM_SCHEMA_HOSTED_PHASE_CONFLICT]: Schema admission and legacy ORM schema authority cannot be
composed together: CatalogDbContext uses ensureCreated, OrdersDbContext uses migrateOnStart. Use one schema mode in the
application: ensureCreated (with or without migrations) in every module, or migrateOnStart/migrations without
ensureCreated in every module.
```

`ensureCreated` и `migrateOnStart` в одном модуле тоже нельзя:
`ensureCreated` и так добавляет безопасные изменения, а остальное — дело
миграций.

## Имена ограничений

Первичный ключ называется `pk_<таблица>`, индекс — `ix_<таблица>_<столбцы>`,
внешний ключ — `fk_<таблица>_<столбцы>`. Если в базе тот же ключ или
индекс называется иначе (таблицу создала старая версия bazis или другой
инструмент), `ensureCreated` не останавливает запуск, а предлагает
переименовать:

```text
[orm:schema] table "public"."products": index is named "legacy_code", the model expects "ix_products_code". It works as is; to align the name run: ALTER INDEX "public"."legacy_code" RENAME TO "ix_products_code";
```

> [!NOTE]
> До 0.98.20 индекс из `@Index()` на свойстве назывался по имени
> **класса**, а не таблицы. Для сущности `User` с `@Entity({ table: "app_users" })`
> получалось `ix_users_email`. Теперь имя строится от таблицы:
> `ix_app_users_email`. В старых базах вы увидите предупреждение выше, а
> `migrateOnStart` не создаст второй такой же индекс.

## Ошибки

| Ошибка | Когда |
| --- | --- |
| `SchemaMigrationRequiredError` | Модель и база расходятся так, что нужна миграция |
| `SchemaAdmissionError` `ORM_SCHEMA_ADDITIVE_DATA_VIOLATION` | Данные мешают безопасному изменению (дубли для уникального индекса) |
| `SchemaAdmissionError` `ORM_SCHEMA_CROSS_UNIT_FOREIGN_KEY` | Внешний ключ на сущность другого контекста |
| `SchemaAdmissionError` `ORM_SCHEMA_OWNERSHIP_CONFLICT` | Одну таблицу создают два контекста или две сущности |
| `SchemaAdmissionError` `ORM_SCHEMA_HOSTED_PHASE_CONFLICT` | В модулях разные режимы схемы |
| `OrmError` `Migration "…" failed and was rolled back` | Упала миграция; её изменения отменены |

## Дальше

- [Сущности и ключи](entities.md)
- [Немедленные изменения](immediate.md)
- [Ошибки базы данных](errors.md)
