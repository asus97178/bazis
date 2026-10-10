# Запросы

Запрос строится цепочкой методов `DbSet` и выполняется последним методом
цепочки — `toList()`, `first()`, `count()`. Условия переводятся в SQL с
параметрами: значения из запроса пользователя никогда не попадают в текст
SQL.

Все примеры проверены на bazis 0.98.16 и PostgreSQL 17.

```ts
const popular = await this.db.posts
  .where((p) => p.views.gt(100))
  .orderByDescending((p) => p.views)
  .take(10)
  .toList();
```

Каждый шаг возвращает новый запрос, а не меняет старый, — запрос можно
собирать по частям:

```ts
let query = this.db.posts.where((p) => p.authorId.eq(authorId));
if (onlyPublished) query = query.where((p) => p.publishedAt.isNotNull());
const posts = await query.orderBy((p) => p.id).toList();
```

## Условия

`where((p) => ...)` получает поля сущности; у каждого поля есть методы
сравнения:

| Метод | SQL |
| --- | --- |
| `eq(v)`, `ne(v)` | `=`, `<>`; `eq(null)` — `IS NULL` |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` — числа, строки, даты |
| `in([a, b])` | `IN (...)`; пустой список — ни одной строки |
| `isNull()`, `isNotNull()` | `IS NULL`, `IS NOT NULL` |
| `contains(s)`, `startsWith(s)`, `endsWith(s)` | `LIKE` |
| `like(pattern)` | `LIKE` со своим шаблоном |

Условия объединяются методами `.and()`, `.or()`, `.not()`; несколько
`where` подряд — то же, что `.and()`:

```ts
db.posts.where((p) => p.views.gte(50).and(p.authorId.eq(bobId)))
db.posts.where((p) => p.views.eq(0).or(p.views.gt(200)))
db.posts.where((p) => p.views.gt(70).not())
```

### Не `&&`, `||` и `>`

Условие — объект JavaScript, а не логическое значение. `a && b` вернёт
только `b`, `a || b` — только `a`, и половина условия молча пропадёт:

```ts
// так нельзя: применится только authorId
db.posts.where((p) => p.views.gt(70) && p.authorId.eq(2))
```

`bazis codegen` находит `&&`, `||` и `!` над условиями и останавливается:

```text
BAZIS_ORM_PREDICATE_LOGIC: src/app/modules/blog/Posts.service.ts:4:46: ORM conditions cannot use JavaScript truthiness:
JavaScript keeps only one side of && and ||. Use .and(), .or(), .not(): (p) => p.views.gt(70).and(p.authorId.eq(2)).
```

`p.views > 70` не пропустит TypeScript, а если обойти его приведением
типов, запрос остановится с подсказкой:

```text
where() expects a condition such as (p) => p.views.gt(70), got boolean. Use .gt()/.eq()/.and()/.or() instead of >, ===, &&, ||.
```

> [!NOTE]
> Эта подсказка — с версии 0.98.16. Раньше ошибка была
> `undefined is not an object (evaluating 'condition.kind')`.

### Поиск по тексту

`contains`, `startsWith`, `endsWith` учитывают регистр. Без учёта регистра —
`{ ignoreCase: true }`, в SQL это `ILIKE`:

```ts
db.posts.where((p) => p.title.contains("sql", { ignoreCase: true }))   // "Intro to SQL", "sql_style"
db.posts.where((p) => p.title.eq("bun tips", { ignoreCase: true }))    // "Bun tips"
```

Символы `%` и `_` в искомой строке ищутся как есть: `contains("%")`
найдёт `"100% coverage"`, а не все строки. Шаблон со своими `%` и `_` —
`like("2026-%")`.

> [!NOTE]
> `ignoreCase` — с версии 0.98.16.

## Порядок и страницы

```ts
db.posts.orderBy((p) => p.authorId).orderByDescending((p) => p.views)   // ORDER BY "authorId", "views" DESC
db.posts.orderBy((p) => p.id).skip(20).take(10)                         // третья страница по 10
```

Второй `orderBy` добавляет следующий ключ сортировки. Без `orderBy`
порядок строк PostgreSQL не гарантирует — для страниц сортируйте всегда.
Для списков в HTTP есть готовая модель с фильтрами и страницами — см.
[Списки и JSON:API](../http/lists.md).

## Результат

| Метод | Результат |
| --- | --- |
| `toList()` | Массив |
| `first(cond?)` | Первая строка; если нет — `EntityNotFoundError` |
| `firstOrDefault(cond?)` | Первая строка или `null` |
| `count(cond?)` | Число строк |
| `any(cond?)` | Есть ли хоть одна |
| `find(key)` | По ключу (см. [`DbContext` и `DbSet`](dbcontext.md)) |

```ts
await db.posts.count((p) => p.views.gt(70));        // 3
await db.posts.any((p) => p.views.gt(1000));        // false
await db.posts.first((p) => p.views.gt(9999));      // EntityNotFoundError: Sequence contains no elements for entity "Post".
```

Агрегатов (`sum`, `max`, `avg`) и группировки в запросах нет — для них
используйте [сырой SQL](dbcontext.md#сырой-sql).

## Только нужные поля

`select` читает выбранные столбцы в простые объекты:

```ts
await db.posts.select((p) => ({ name: p.title, views: p.views })).where((p) => p.views.gt(100)).toList();
// [{ name: "Intro to SQL", views: 120 }, { name: "Bun tips", views: 300 }]
```

В `select` можно только перечислить поля — вычисления делайте после
`toList()`:

```text
select() maps properties as they are, e.g. (p) => ({ name: p.title }); compute values after toList().
```

> [!NOTE]
> Эта подсказка — с версии 0.98.16. Раньше `({ label: `${p.title}!` })`
> давал `Property "title!" is not mapped… Did you forget @Column()?`.

## Связи и `include`

```ts
@Entity({ table: "authors" })
export class Author {
  @Key() id = 0;
  @Column({ type: "text" }) @Required() name = "";
  @OneToMany(() => Post, { foreignKey: "authorId" }) posts: Post[] = [];
}

@Entity({ table: "posts" })
export class Post {
  @Key() id = 0;
  @Column({ type: "integer" }) @Required() authorId = 0;
  @ManyToOne(() => Author, { foreignKey: "authorId" }) author?: Author;
  // ...
}
```

Связанные сущности сами не загружаются — `post.author` будет
`undefined`. Загрузите их явно:

```ts
await db.posts.include((p) => p.author).toList();     // "Intro to SQL by Ann"
await db.authors.include((a) => a.posts).toList();    // "Ann: 3", "Bob: 2"
await db.authors.include((a) => a.posts).thenInclude((p) => p.comments).toList();
```

`include` выполняет отдельный запрос на каждую связь, а не `JOIN`: строки
основной таблицы не размножаются.

## Отслеживание

По умолчанию загруженные сущности отслеживаются контекстом: изменения
в них сохранит `saveChanges()`, а одна и та же строка в разных запросах —
один и тот же объект. Для чтения, которое не будет меняться, —
`asNoTracking()`: так быстрее и не тратится память контекста.

```ts
const a = await db.posts.where((p) => p.id.eq(1)).toList();
const b = await db.posts.where((p) => p.id.eq(1)).toList();
a[0] === b[0];                                                  // true
(await db.posts.asNoTracking().where((p) => p.id.eq(1)).toList())[0] === a[0];   // false
```

Подробнее — в главе «Сохранение и отслеживание изменений».

## Дальше

- [`DbContext` и `DbSet`](dbcontext.md)
- [Списки и JSON:API](../http/lists.md)
- Сохранение и отслеживание изменений *(в работе)*
