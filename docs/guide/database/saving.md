# Сохранение и отслеживание изменений

Контекст запоминает загруженные сущности и сравнивает их при
`saveChanges()` с тем, что было в базе. Отправляются только изменения —
одной транзакцией.

Все примеры проверены на bazis 0.109.0 и PostgreSQL 17.

## Добавить, изменить, удалить

```ts
// добавить
const article = this.db.articles.add(Object.assign(new Article(), { title: "First", slug: "first" }));

// изменить загруженную — просто поменять поля
const loaded = await this.db.articles.find(1);
loaded!.views = 10;

// удалить
this.db.articles.remove(old);

await this.db.saveChanges();   // всё — в одной транзакции
```

```text
INSERT INTO "articles" ("title", "slug", "views", "meta", "authorId") VALUES ($1, $2, $3, $4, $5) RETURNING "id"
UPDATE "articles" SET "views" = $1 WHERE "id" = $2
DELETE FROM "articles" WHERE "id" = $1
```

- `saveChanges()` возвращает число сохранённых сущностей.
- Ключ, выданный базой, после сохранения уже в объекте: `article.id`.
- `UPDATE` меняет **только изменённые** столбцы. Если ничего не
  поменялось, запроса нет, и `saveChanges()` возвращает `0`.
- Изменение внутри JSON-столбца (`article.meta.tags.push("bun")`) тоже
  замечается.
- Несколько новых строк одной таблицы уходят одним `INSERT` на несколько
  строк.

## Состояния

| Состояние | Что значит | Что сделает `saveChanges()` |
| --- | --- | --- |
| `Detached` | Контекст не знает объект | Ничего |
| `Added` | Новый, после `add()` | `INSERT` |
| `Unchanged` | Загружен, не изменён | Ничего |
| `Modified` | Загружен и изменён | `UPDATE` изменённых столбцов |
| `Deleted` | После `remove()` | `DELETE` |

```ts
import { EntityState } from "bazis/core/orm";

this.db.stateOf(article);   // EntityState.Added
```

Изменения ищутся сравнением при `saveChanges()`. До этого изменённая
сущность показывает `Unchanged`; чтобы увидеть `Modified` раньше, вызовите
`this.db.changeTracker.detectChanges()`.

`remove()` для ещё не сохранённой (`Added`) сущности просто забывает её —
в базу ничего не уйдёт.

## Связанные сущности

Связь можно задать навигацией — внешний ключ ORM проставит сам:

```ts
const bob = Object.assign(new Author(), { name: "Bob" });
const article = Object.assign(new Article(), { title: "By Bob", slug: "by-bob", author: bob });
// или: bob.articles.push(article);

this.db.authors.add(bob);
this.db.articles.add(article);
await this.db.saveChanges();

article.authorId;   // = bob.id
```

ORM сначала вставляет автора, получает его `id` и только потом —
статью. Так же работает перенос: `loaded.author = otherAuthor` изменит
`authorId` у загруженной статьи.

Навигация учитывается, только если связанный объект знает этот контекст
(добавлен или загружен им). Если внешний ключ задан и полем, и навигацией
с разными значениями, побеждает навигация.

> [!NOTE]
> Внешний ключ из навигации — с версии 0.98.17. Раньше `article.author =
> bob` оставлял `authorId = 0`, и вставка падала с `violates foreign key
> constraint`.

## Объекты не из этого контекста

Объект, пришедший не из этого контекста (из другого запроса, из кэша,
собранный из тела запроса), можно сохранить без загрузки:

| Метод | Что сделает |
| --- | --- |
| `update(entity)` | `UPDATE` **всех** столбцов по ключу |
| `remove(entity)` | `DELETE` по ключу — достаточно объекта с ключом |
| `attach(entity)` | Начнёт отслеживать как `Unchanged`; дальше — обычное сравнение |

```ts
this.db.articles.remove(Object.assign(new Article(), { id: 3 }));
await this.db.saveChanges();   // DELETE FROM "articles" WHERE "id" = $1
```

`update` перезаписывает все поля значениями объекта, включая те, что вы
не меняли. Если в объекте не все поля, сначала загрузите сущность через
`find` и поменяйте нужные.

## Если сохранение не удалось

Сохранение атомарно: при любой ошибке не сохраняется **ничего** из
`saveChanges()`, а контекст остаётся в прежнем состоянии — изменения
можно исправить и сохранить снова.

```ts
db.articles.add(ok);
db.articles.add(dup);              // slug уже занят
await db.saveChanges();            // UniqueViolationError: Unique constraint "ix_articles_slug" violated.
// ok тоже не сохранён

dup.slug = "dup";
await db.saveChanges();            // 2 — сохранены обе
```

| Ошибка | Когда |
| --- | --- |
| `OrmValidationError` | Правило `@Validator` на свойстве сущности не выполнено — до SQL |
| `UniqueViolationError` | Нарушен уникальный индекс; имя индекса — в `error.constraint` |
| `DbUpdateError` | Например, изменён первичный ключ отслеживаемой сущности |

```ts
@Validator({ required: true, minLength: 3 }) @Column({ type: "text" }) @Required() title = "";
// OrmValidationError: Validation failed for "Article": Field "title" must be at least 3 characters long
```

Сущность, не прошедшая проверку, остаётся в контексте: следующий
`saveChanges()` снова упадёт, пока её не исправить или не убрать через
`remove()`.

Первичный ключ загруженной сущности менять нельзя:

```text
DbUpdateError: Primary key for tracked entity "Article" cannot be changed.
```

## Повтор при временном сбое

Взаимная блокировка (deadlock) или обрыв соединения проходят сами, если
повторить сохранение. `executionStrategy` модуля включает такие повторы:

```ts
@Module({
  ormBazis: {
    context: Customers,
    entities: [Customer],
    executionStrategy: { maxRetries: 3, baseDelayMs: 50 },
  },
  exports: [],
})
export class CustomersModule {}
```

Два запроса сохраняют одни и те же строки в обратном порядке, и PostgreSQL
прерывает один из них:

```text
без executionStrategy  {"first":"deadlock detected","second":"ok in 1621 ms"}
с executionStrategy    {"first":"ok in 2233 ms","second":"ok in 1622 ms"}
```

| Настройка | По умолчанию | Что задаёт |
| --- | --- | --- |
| `maxRetries` | `3` | Сколько раз повторить после первой попытки |
| `baseDelayMs` | `50` | Пауза перед первым повтором; дальше вдвое больше: 50, 100, 200 мс |
| `isTransient(error)` | см. ниже | Какую ошибку повторять |

Без `executionStrategy` повторов нет.

Повторяются ошибки: `deadlock detected`, `could not serialize` (`40001`),
обрыв соединения (`ECONNRESET`, `ETIMEDOUT`, `connection terminated`,
`08006`, `57P01`, `ERR_POSTGRES_CONNECTION_CLOSED`).

- **Повторяется `saveChanges()` вне транзакции**, целиком, в новой
  транзакции. Внутри `transactionScope` отдельный шаг не повторяется: так
  можно записать часть транзакции дважды. Транзакцию повторяют целиком —
  [`transactionScope(work, { retry: true })`](transactions.md#повтор-при-взаимной-блокировке).
  Запросы (`find`, `toList`) и сырой SQL вне транзакции не повторяются.
- **Обрыв во время `COMMIT` не повторяется**: неизвестно, записались ли
  данные (`TransactionOutcomeUnknownError`).
- **Повтор отправляет те же значения**, строку он не перечитывает. В
  примере выше оба запроса дописали `!` к имени, а в базе `Анна!`, не
  `Анна!!`: второе сохранение затёрло первое. Если важно, кто записал
  последним, читайте строку с блокировкой (`findForUpdate`) в
  `transactionScope`.

## Дальше

- [Запросы](queries.md)
- [`DbContext` и `DbSet`](dbcontext.md)
- [Транзакции](transactions.md)
- [Немедленные изменения](immediate.md)
