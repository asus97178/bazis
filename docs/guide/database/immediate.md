# Немедленные изменения

`saveChanges()` сначала загружает сущности, потом пишет изменения. Когда
нужно поменять или удалить много строк по условию, загружать их незачем.
Для этого есть три команды, которые сразу отправляют один SQL-запрос:

| Команда | SQL |
| --- | --- |
| `query.executeUpdate(values)` | `UPDATE … SET … WHERE …` |
| `query.executeDelete()` | `DELETE FROM … WHERE …` |
| `dbSet.insertIfAbsent(entity, { conflictBy })` | `INSERT … ON CONFLICT (…) DO NOTHING` |

Все примеры проверены на bazis 0.98.19 и PostgreSQL 17.

## Изменить по условию

```ts
const result = await this.db.articles
  .asNoTracking()
  .where((a) => a.views.lt(5))
  .executeUpdate({ status: "archived" });

result.affectedRows;   // 2
```

```text
UPDATE "articles" SET "status" = $1 WHERE "views" < $2   ["archived", 5]
```

- Запрос начинается с `.asNoTracking()`: команда идёт мимо контекста и не
  трогает загруженные сущности.
- Условие `where(...)` обязательно.
- В `values` — готовые значения для нескольких столбцов сразу:
  `{ status: "published", publishedAt: new Date() }`.
- `null` записывает `NULL` в столбец, который это допускает:
  `executeUpdate({ publishedAt: null })`.
- Возвращает `{ affectedRows }` — сколько строк изменено.

## Удалить по условию

```ts
await this.db.articles
  .asNoTracking()
  .where((a) => a.status.eq("archived").and(a.views.lt(2)))
  .executeDelete();
```

```text
DELETE FROM "articles" WHERE ("status" = $1 AND "views" < $2)   ["archived", 2]
```

### Мягкое удаление и фильтры

Фильтры запросов (`@QueryFilter`) и условие `@SoftDelete` добавляются к
`where`, как в обычном запросе. Но `executeDelete()` удаляет строки
**по-настоящему**, а не помечает `deletedAt`:

```ts
await this.db.notes.asNoTracking().where((n) => n.text.ne("keep")).executeDelete();
```

```text
DELETE FROM "notes" WHERE "deletedAt" IS NULL AND "text" <> $1   ["keep"]
```

Уже мягко удалённые строки эта команда не видит. Чтобы вычистить их
окончательно, снимите фильтры через `ignoreQueryFilters()`:

```ts
await this.db.notes
  .asNoTracking()
  .ignoreQueryFilters()
  .where((n) => n.deletedAt.isNotNull())
  .executeDelete();
// DELETE FROM "notes" WHERE "deletedAt" IS NOT NULL
```

Мягко удалить много строк сразу можно через `executeUpdate({ deletedAt: new Date() })`.

## Вставить, если такой ещё нет

```ts
const { inserted } = await this.db.tags.insertIfAbsent(
  Object.assign(new Tag(), { name: "bun", uses: 1 }),
  { conflictBy: (t) => [t.name] },
);
// inserted: true — вставили; false — тег "bun" уже был, строка не изменилась
```

```text
INSERT INTO "tags" ("name", "uses") VALUES ($1, $2) ON CONFLICT ("name") DO NOTHING
```

- `conflictBy` — первичный ключ или уникальный индекс (`@Index({ unique: true })`),
  по которому определяется «уже есть». Другие столбцы не подходят:

  ```text
  OrmUndeclaredConflictTargetError: Immediate ORM mutation conflict target is not a declared unique key:
  conflictBy (title) is not the primary key or a unique index of Article. Use one of: (id), (slug);
  or declare @Index({ unique: true }) on these properties.
  ```

- Передайте сущность со **всеми** полями: удобнее всего `new Tag()` с
  нужными значениями. В объекте без поля будет ошибка:
  `"uses" is missing; pass an entity with every mapped property of Tag`.
- Незаданный ключ выдаёт база (`@Key() id = 0`), а для
  `@UUID({ version: "v7" })` ORM генерирует UUID v7 сам, как при
  `saveChanges()`. Явно заданный ключ вставляется как есть.
- Переданный объект не меняется и не попадает в контекст: выданный
  ключ в него не записывается. Нужен ключ — прочитайте строку по
  уникальному полю или задайте UUID v7 заранее (`id: Bun.randomUUIDv7()`).
- `@CreatedAt`/`@UpdatedAt` не заполняются: значения берутся из объекта.

> Даже пропущенная из-за конфликта вставка тратит номер из
> последовательности identity, поэтому в `id` бывают дыры. Это обычное
> поведение PostgreSQL.

## Чего нельзя

Каждое ограничение проверяется до запроса, и ошибка называет причину:

| Что сделали | Ошибка (`OrmUnsafeImmediateMutationError`) |
| --- | --- |
| Забыли `.asNoTracking()` | `call .asNoTracking() before executeUpdate(); immediate mutations bypass the change tracker` |
| Нет `where` | `add .where(...) before executeDelete(); changing every row of a table is not allowed, use raw SQL for that` |
| `take`, `skip`, `orderBy`, `include`, `select`, `forUpdate` | `executeUpdate() does not accept take() or skip(); narrow the rows with where(...)` |
| Опечатка в имени поля | `"satus" is not a mapped property of Article` |
| Меняют ключ | `"id" is the primary key of Article and cannot be changed` |
| `@CreatedAt`, `@UpdatedAt`, `@UUID` | `"createdAt" is filled automatically and cannot be set` |
| `null` в обязательный столбец | `"title" is required (NOT NULL) and cannot be set to null` |
| Не тот тип | `"views" expects integer, got string` |

Полный текст начинается с `Immediate ORM mutation input is unsafe or
unsupported:`, дальше идёт причина.

### Выражения: `views = views + 1`

В `values` попадают только готовые значения. Функция или выражение не
сработают:

```text
"views" must be a value, got a function; expressions such as views + 1 are not supported, use raw SQL for them
```

Для счётчиков используйте сырой SQL:

```ts
await this.db.database.executeSqlRaw("UPDATE articles SET views = views + 1 WHERE id = {0}", id);
```

## Немедленные изменения и отслеживание

Если контекст уже отслеживает сущности той же модели (вы загрузили их
обычным запросом или сохранили через `saveChanges()`), команда
откажется работать. Иначе загруженные объекты молча разошлись бы с базой:

```ts
const article = await this.db.articles.find(2);
article!.title = "B2";
await this.db.saveChanges();

await this.db.articles.asNoTracking().where((a) => a.views.lt(5)).executeUpdate({ status: "x" });
```

```text
OrmTrackedMutationConflictError: Immediate ORM mutation conflicts with tracked entities: this context
tracks "Article" entities (loaded with tracking or saved through saveChanges()), which the mutation
would make stale. Load them with .asNoTracking(), or run the mutation in a separate DbContext.
```

- Сущности **другой** модели не мешают: с загруженными `Tag` можно
  выполнить `executeUpdate` для `Article`.
- Читайте нужные данные через `.asNoTracking()`, если в том же запросе
  будет немедленное изменение.
- Или выполните его в отдельном контексте, например в фоновой задаче.

## В транзакции

Внутри `transactionScope` немедленные изменения идут в ту же транзакцию
и откатываются вместе с ней:

```ts
await this.db.transactionScope(async () => {
  await this.db.articles.asNoTracking().where((a) => a.id.eq(2)).executeUpdate({ views: 999 });
  throw new Error("undo");
});
// BEGIN / UPDATE … / ROLLBACK — views не изменился
```

Подробнее — в главе [Транзакции](transactions.md).

## Дальше

- [Сохранение и отслеживание изменений](saving.md)
- [Транзакции](transactions.md)
- [Ошибки базы данных](errors.md)
