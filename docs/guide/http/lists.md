# Списки и JSON:API

Списки — фильтры, сортировка, страницы — в bazis описываются одним
классом. Он задаёт, что клиенту разрешено, а `paginate` превращает запрос
в SQL с параметрами. Параметры строки запроса — в стиле
[JSON:API](https://jsonapi.org/format/#fetching).

Все примеры проверены на bazis 0.98.2 с PostgreSQL.

## Модель списка

```ts
import { Filterable, ListOptions, ListRequest, Sortable } from "bazis/core/http";
import type { Task } from "../../model/Task.model";

@ListOptions({ defaultSize: 20, maxSize: 100, defaultSort: "-createdAt" })
export class TaskListQuery extends ListRequest<Task> {
  @Sortable()
  @Filterable("eq", "contains", "startsWith")
  name!: string;

  @Sortable()
  @Filterable("eq", "contains")
  email!: string;

  @Sortable()
  createdAt!: Date;
}
```

Разрешено **только объявленное**: сортировать можно по полям с
`@Sortable()`, фильтровать — по полям с `@Filterable(...)` и только
перечисленными операторами. Всё остальное — `400`. `bazis g module`
создаёт такую модель сам: `http/contracts/TaskList.query.ts`.

## Контроллер и сервис

```ts
import { buildListDocument } from "bazis/library/jsonapi";

@Get()
async list(query: TaskListQuery, ctx: HttpContext) {
  const { items, total } = await this.tasks.getAll(query);
  return buildListDocument(items, query, total, { basePath: ctx.path });
}
```

```ts
import { paginate } from "bazis/core/orm";
import type { ListQuery } from "bazis/library/jsonapi";

async getAll(query: ListQuery) {
  const { items, total } = await paginate(this.db.tasks.asNoTracking(), query);
  return { items: items.map(toTaskResponse), total };
}
```

Параметр-наследник `ListRequest` codegen привязывает к строке запроса
целиком. `paginate` применяет фильтры, сортировку и страницу к запросу
ORM и отдельно считает `total`. Значения из запроса всегда уходят в SQL
параметрами, а не текстом.

## Ответ

```json
{
  "data": [{ "id": "…", "name": "Carol", "email": "carol@test.org", "createdAt": "…" }, …],
  "meta": { "total": 5, "page": 2, "size": 2, "pageCount": 3 },
  "links": {
    "self":  "/tasks?sort=name&page%5Bnumber%5D=2&page%5Bsize%5D=2",
    "first": "/tasks?sort=name&page%5Bnumber%5D=1&page%5Bsize%5D=2",
    "last":  "/tasks?sort=name&page%5Bnumber%5D=3&page%5Bsize%5D=2",
    "prev":  "/tasks?sort=name&page%5Bnumber%5D=1&page%5Bsize%5D=2",
    "next":  "/tasks?sort=name&page%5Bnumber%5D=3&page%5Bsize%5D=2"
  }
}
```

`links` строятся, если передан `basePath`; в них сохраняются все
параметры запроса, кроме номера страницы. `prev` нет на первой странице,
`next` — на последней.

## Параметры запроса

### Сортировка

| Запрос | Порядок |
| --- | --- |
| `?sort=name` | По имени, по возрастанию |
| `?sort=-name` | По убыванию |
| `?sort=-createdAt,name` | Сначала новые, при равенстве — по имени |
| без `sort` | `defaultSort` из `@ListOptions`, иначе — по первичному ключу |

Первичный ключ всегда добавляется последним критерием: записи с
одинаковыми значениями не «перескакивают» между страницами.

`defaultSort` — в том же синтаксисе, что и параметр; каждое поле в нём
должно быть `@Sortable()`, иначе ошибка при объявлении класса:

```text
@ListOptions on TaskListQuery: defaultSort field "email" is not @Sortable().
```

### Фильтры

| Запрос | Условие |
| --- | --- |
| `?filter[name]=Bob` | `name = 'Bob'` — без оператора это `eq` |
| `?filter[email][contains]=test` | Содержит |
| `?filter[name][startsWith]=Ca` | Начинается с |
| `?filter[name]=Bob&filter[email][contains]=example` | Оба условия (И) |
| `?filter[or][0][name]=Alice&filter[or][1][name]=Eve` | Хотя бы одна группа (ИЛИ) |

Операторы: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`,
`startsWith`, `endsWith`, `like`, `in`, `nin`, `isNull`, `isNotNull`.
Условия внутри одной группы `or[N]` соединяются через И, разные группы —
через ИЛИ.

### Страницы

| Запрос | Что вернётся |
| --- | --- |
| `?page[number]=2&page[size]=2` | Вторая страница по 2 записи |
| `?page[offset]=4&page[limit]=2` | 2 записи, начиная с пятой |
| без `page` | Первая страница размера `defaultSize` |
| `?page[size]=500` при `maxSize: 100` | Страница из 100 — размер молча урезается |

### Выбор полей

`?fields[tasks]=name` оставляет в каждой записи только `id` и `name`:

```json
{"data":[{"id":"0cca…","name":"Eve"},{"id":"b4c6…","name":"Dave"}], …}
```

Тип ресурса (`tasks`) — последний сегмент `basePath`; другой можно
указать опцией `buildListDocument(..., { basePath, type: "todo" })`.
Записи сокращаются в ответе, а база по-прежнему читает все столбцы —
это экономия трафика, а не запроса.

> [!NOTE]
> `defaultSort` и применение `fields[...]` — с версии 0.98.2. Раньше
> `fields` принимался, но не менял ответ.

## Ошибки

Все нарушения собираются в один ответ `400`:

```text
GET /tasks?filter[createdAt][gt]=2020&filter[name][gte]=A&page[number]=0
```

```json
{
  "error": "Invalid list query",
  "details": [
    { "parameter": "filter[createdAt][gt]", "message": "filtering by \"createdAt\" is not allowed" },
    { "parameter": "filter[name][gte]", "message": "operator \"gte\" is not allowed for \"name\"" },
    { "parameter": "page[number]", "message": "must be a positive integer" }
  ]
}
```

То же для сортировки (`sorting by "secret" is not allowed`) и связей
(`include "owner" is not allowed`).

## Дальше

- [Маршрутизация и привязка параметров](routing.md)
- [Ответы](../overview/responses.md)
- [Файлы и загрузка](files.md)
