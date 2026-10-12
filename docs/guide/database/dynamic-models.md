# Динамические модели

Обычная сущность — это класс с `@Entity`, известный при сборке. Динамическая
модель описывается **данными во время работы**: например, пользователь сам
создаёт в интерфейсе таблицу «Заявки» с полями «Название» и «Сумма». ORM
строит по такому описанию модель, создаёт таблицу и работает с её строками
как с обычными сущностями.

Все примеры проверены на bazis 0.98.24 и PostgreSQL 17.

## Описание таблицы

```ts
import { buildDynamicModel, type DynamicTableDefinition } from "bazis/core/orm";

const leads: DynamicTableDefinition = {
  name: "Leads",          // имя модели: по нему берётся setByName("Leads")
  tableName: "leads",     // имя таблицы (по умолчанию — name)
  fields: [
    { name: "id", type: "int", isKey: true },
    { name: "name", type: "string", required: true },
    { name: "email", type: "string", unique: true },
    { name: "meta", type: "json" },
    { name: "createdAt", type: "datetime", convention: "createdAt" },
  ],
};

const model = buildDynamicModel(leads);
```

| `type` | Столбец PostgreSQL |
| --- | --- |
| `string` | `text` |
| `int`, `bigint` | `bigint` |
| `decimal` | `double precision` — **не точное число**, см. ниже |
| `bool` | `boolean` |
| `datetime` | `timestamp with time zone` |
| `uuid` | `text` |
| `json` | `jsonb` |
| `foreignKey` | Тип ключа целевой таблицы (`targetKeyType`) |

- `isKey` — первичный ключ. Целый ключ выдаёт база (identity).
- `required` — `NOT NULL`; по умолчанию столбец допускает `NULL`.
- `unique` / `indexed` — индекс по столбцу.
- `convention: "createdAt" | "updatedAt" | "uuid"` — значение заполняется
  при сохранении, как у [`@CreatedAt`](entities.md).

> [!WARNING]
> `decimal` хранится как `double precision`: `0.1 + 0.2` запишется как
> `0.30000000000000004`. Для денег храните целые копейки в `int`.

> [!NOTE]
> Поле типа `uuid`, кроме ключа, заполняется само, если значение не
> задано (как `convention: "uuid"`), и хранится как `text`.

## Регистрация и работа со строками

Модель регистрируется в `DbContextOptions`, после чего строки доступны
через `setByName`:

```ts
import { DbContext, DbContextOptions, buildDynamicModel } from "bazis/core/orm";

class DynamicDb extends DbContext {}

const options = new DbContextOptions({ provider, entities: [] });
options.model.registerModel(buildDynamicModel(leads));

const db = new DynamicDb(options);
await db.database.ensureCreated();
// [create table leads, create unique index ix_leads_email on leads (email)]

const lead = db.setByName("Leads").add({ name: "Ann", email: "ann@x.io", meta: { source: "web" } });
await db.saveChanges();
lead.id;   // 1

const found = await db.setByName("Leads").find(1);
found!.name = "Anna";
await db.saveChanges();   // UPDATE "leads" SET "name" = $1 WHERE "id" = $2
```

Строки — обычные объекты, с ними работают **через их набор**:
`db.setByName("Leads").add(row)`. Через `db.add(row)` нельзя — контекст не
знает, к какой таблице относится простой объект:

```text
EntityNotMappedError: A plain object is not an entity class. For a dynamic table add the row through its set: db.setByName("Table").add(row).
```

Запросы — как у обычного `DbSet` ([Запросы](queries.md)). Тип строки —
`Record<string, unknown>`, поэтому поле в условии удобно привести:

```ts
import type { Operand } from "bazis/core/orm";

const hot = await db.setByName("Leads")
  .where((l) => (l as { score: Operand<number> }).score.gt(0.2))
  .toList();
```

Незарегистрированное имя:

```text
EntityNotMappedError: No entity or dynamic model named "Tickets" is registered in this DbContext. Register a dynamic
table first: options.model.registerModel(buildDynamicModel({ name: "Tickets", fields: [...] })).
```

Чтобы ответить клиенту `404`, а не `500`, проверьте имя заранее:
`options.model.tryByName(name)` вернёт модель или `undefined`.

## Связи между динамическими таблицами

Поле `foreignKey` ссылается на другую динамическую таблицу. Модель цели
передаётся функцией-резолвером:

```ts
const companies = buildDynamicModel({ name: "Companies", tableName: "companies", fields: [
  { name: "id", type: "int", isKey: true },
  { name: "title", type: "string", required: true },
] });

const leads = buildDynamicModel({ name: "Leads", tableName: "leads", fields: [
  { name: "id", type: "int", isKey: true },
  { name: "name", type: "string", required: true },
  { name: "companyId", type: "foreignKey", target: "Companies", navigationName: "company", targetKeyType: "int" },
] }, (name) => companies.ctor);

options.model.registerModel(companies);
options.model.registerModel(leads);
await db.database.ensureCreated();
// [create table companies, create table leads, add foreign key fk_leads_companyId on leads]

await db.setByName("Leads").include((l) => (l as { company: unknown }).company).toList();
// [{ id: 1, name: "Ann", companyId: 1, company: { id: 1, title: "Acme" } }]
```

Без резолвера — ошибка ещё при построении:

```text
ModelBuildError: Dynamic table "Leads" references target "Companies" but no target resolver was provided.
```

## Изменение таблицы на лету

Пользователь добавил поле — постройте модель заново, зарегистрируйте под тем
же именем и вызовите `ensureCreated`. Безопасные изменения применятся
сами ([Управление схемой](schema.md)):

```ts
options.model.registerModel(buildDynamicModel({ ...leadsDefinition, fields: [...leadsDefinition.fields, { name: "phone", type: "string" }] }, resolve));
await db.database.ensureCreated();   // applied: ["add column leads.phone"]
```

Регистрация действует сразу для всех контекстов на этих опциях.
`options.model.unregister("Leads")` убирает модель, но **не** таблицу в базе.

## В приложении с DI

Контексты из `ormBazis` держат свою модель закрытой: динамические таблицы
в них не регистрируются. Для них заведите отдельный реестр поверх общего
подключения — `DatabaseProvider` из `@Infra` внедряется обычным
конструктором:

```ts
import { Module, scoped, singleton } from "bazis/core/di";
import { DbContext, DbContextOptions, buildDynamicModel, type DatabaseProvider, type DynamicTableDefinition } from "bazis/core/orm";

export class DynamicDb extends DbContext {}

/** Реестр таблиц, созданных во время работы. */
export class DynamicSchema {
  readonly options: DbContextOptions;
  constructor(provider: DatabaseProvider) {
    this.options = new DbContextOptions({ provider, entities: [] });
  }
  async define(definition: DynamicTableDefinition) {
    this.options.model.registerModel(buildDynamicModel(definition));
    return new DynamicDb(this.options).database.ensureCreated();
  }
}

export class RowsService {
  private readonly db: DynamicDb;
  constructor(schema: DynamicSchema) {
    this.db = new DynamicDb(schema.options);   // свой контекст на запрос
  }
  async add(table: string, row: Record<string, unknown>) {
    const added = this.db.setByName(table).add(row);
    await this.db.saveChanges();
    return added;
  }
}

@Module({ providers: [singleton(DynamicSchema), scoped(RowsService)] })
export class DynamicModule {}
```

`DynamicSchema` — singleton: описание таблиц общее. `RowsService` — scoped:
у каждого запроса свой контекст и свой трекер. Описания таблиц обычно
хранят в собственном каталоге (таблице метаданных) и при старте
регистрируют заново.

## Ошибки описания

| Ошибка | Когда |
| --- | --- |
| `has no primary key. Mark one field with isKey, or set primaryKey` | Нет ключа |
| `declares several isKey fields ("a", "b") … use primaryKey: { properties: ["a", "b"] }` | Два `isKey` — для составного ключа нужен `primaryKey` |
| `unknown field type "integer"` | Неверный `type` (верно — `int`) |
| `foreign key field "companyId" has no targetKeyType` | У `foreignKey` нет типа ключа цели |
| `references target "Companies" but no target resolver was provided` | Связь без резолвера |
| `duplicate field "name"` | Два поля с одним именем |

Составной ключ:

```ts
buildDynamicModel({ name: "Pairs", fields: [{ name: "a", type: "int" }, { name: "b", type: "string" }], primaryKey: { properties: ["a", "b"] } });
```

> [!NOTE]
> Сообщения про `primaryKey`, `setByName` и простые объекты — с версии
> 0.98.24.

## Дальше

- [Управление схемой](schema.md)
- [Запросы](queries.md)
- [Сохранение и отслеживание изменений](saving.md)
