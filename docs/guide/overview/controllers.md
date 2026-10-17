# Контроллеры

Контроллер принимает HTTP-запросы. Это класс с декоратором `@Controller`,
методы которого помечены декораторами маршрутов. Логику контроллер держит
тонкой: разбирает запрос, вызывает сервис и возвращает результат.

```ts
import { Controller, Created, Get, HttpContext, NotFound, Post } from "bazis/core/http";

@Controller("tasks")
export class TaskController {
  constructor(private readonly tasks: TaskService) {}

  @Get(":id(uuid)")
  async getById(id: string) {
    const task = await this.tasks.getById(id);
    return task ?? NotFound({ error: `task ${id} not found` });
  }

  @Post()
  async create(body: CreateTaskRequest, ctx: HttpContext) {
    const task = await this.tasks.create(body);
    return Created(`${ctx.path}/${task.id}`, task);
  }
}
```

Контроллер подключают в модуле через `controllers: [TaskController]`.
Регистрировать его в `providers` не нужно: на каждый запрос создаётся новый
экземпляр, а зависимости приходят через конструктор, как у сервисов.

## Маршруты

Адрес метода складывается из префикса контроллера и шаблона метода:
`@Controller("tasks")` + `@Get(":id")` → `GET /tasks/:id`.

| Декоратор | HTTP-метод |
| --- | --- |
| `@Get` · `@Post` · `@Put` · `@Patch` · `@Delete` | Соответствующий метод |
| `@Head` · `@Options` | `HEAD`, `OPTIONS` |
| `@All` | Любой метод |

Части шаблона:

| Запись | Что значит | Пример |
| --- | --- | --- |
| `items` | Обычный сегмент пути | `/tasks/items` |
| `:id` | Параметр — любая строка в этом сегменте | `/tasks/abc` → `id = "abc"` |
| `:id(int)` | Параметр с ограничением | `/tasks/42` → `id = 42`; `/tasks/abc` → 404 |
| `*path` | Остаток пути, только в конце шаблона | `/files/a/b.txt` → `path = "a/b.txt"` |
| `*` | То же, параметр называется `rest` | |

Ограничения параметров: `int`, `number`, `bool`, `uuid`, `alpha` (только
латинские буквы). Если значение не подходит, маршрут не совпадает и клиент
получает 404. Неизвестное ограничение — ошибка при запуске.

Параметры можно ставить и в префикс контроллера:
`@Controller("projects/:projectId/tasks")`.

## Аргументы методов

Источник значения bazis определяет по имени и типу параметра. Когда этого
мало — другое имя в запросе, заголовок, модель строки запроса, — источник
указывают явно, см. [ниже](#явный-источник-fromquery-fromheader-frombody-fromroute).

| Параметр метода | Откуда значение |
| --- | --- |
| Имя совпадает с параметром маршрута | Из пути, с преобразованием по ограничению или типу |
| Класс из исходников приложения (`@RequestModel()` не обязателен) | Из JSON-тела, с проверкой `@Validator` |
| `HttpContext`, `Request`, `ResponseBuilder` | Контекст запроса, исходный запрос, построитель ответа |
| `string` / `number` / `boolean`, которого нет в маршруте | Из строки запроса |

Параметр строки запроса без значения по умолчанию обязателен:

```ts
@Get("search")
search(q: string, limit = 10) { ... }
```

```text
GET /tasks/search?q=bun&limit=5   → q = "bun", limit = 5
GET /tasks/search?q=bun           → q = "bun", limit = 10
GET /tasks/search                 → 400 {"error":"Validation failed","details":[{"property":"q","message":"Field \"q\" is required","code":"required"}]}
GET /tasks/search?q=bun&limit=abc → 400 … {"property":"limit","message":"Field \"limit\" must be of type number, got: string","code":"type"}
```

Если по сигнатуре нельзя понять, откуда брать параметр — например, у него нет
типа или в методе две модели тела, — кодогенерация останавливается с ошибкой
`BAZIS_HTTP_BINDING_UNRESOLVED` и называет метод и причину.

> [!NOTE]
> Параметры из префикса контроллера и `*path` привязываются с версии 0.96.4.

## Явный источник: `FromQuery`, `FromHeader`, `FromBody`, `FromRoute`

В стандартных декораторах TypeScript нет декораторов на параметрах, поэтому
`@Query() q: string`, как в NestJS, не скомпилируется. Источник указывают
типом параметра — так же, как в ASP.NET `[FromQuery]`, только на типе:

```ts
import { Controller, Get, Post, type FromBody, type FromHeader, type FromQuery, type FromRoute } from "bazis/core/http";

@Get("books/:id")
book(id: FromRoute<number>, requestId?: FromHeader<string, "x-request-id">) { … }

@Get("books")
list(size: FromQuery<number, "page_size"> = 10) { … }

@Post("books")
add(body: FromBody<AddBookRequest>) { … }
```

| Тип параметра | Откуда значение |
| --- | --- |
| `FromRoute<number>`, `FromRoute<string, "slug">` | Параметр пути; второй аргумент — имя в шаблоне |
| `FromQuery<number, "page_size">`, `FromQuery<string[]>` | Строка запроса под этим именем; массив — все значения ключа |
| `FromQuery<BookSearchQuery>` | Модель строки запроса — см. ниже |
| `FromHeader<string, "x-request-id">` | Заголовок, без учёта регистра; без имени — имя параметра |
| `FromHeader<LibraryHeaders>` | Модель заголовков |
| `FromBody<AddBookRequest>` | JSON-тело, как класс без маркера |

Во время выполнения это просто тип значения: `FromQuery<number>` — это
`number`. Кодогенерация читает маркер через проверку типов, поэтому работает
и `import { FromQuery as Q }`, а свой тип приложения с именем `FromQuery`
маркером не считается.

### Модели строки запроса и заголовков

Параметры поиска удобно описать классом — с правилами `@Validator`, как
модель тела. Проверка выполняется в контроллере, до вызова метода, — в
сервис приходит уже проверенный объект:

```ts
import { FromHeader, FromQuery } from "bazis/core/http";
import { Validator } from "bazis/library/validation";

export class BookSearchQuery {
  /** Part of the title. */
  @Validator({ required: true, minLength: 2, maxLength: 100 })
  q!: string;

  /** Books per page, 1–50. */
  @FromQuery("page_size") @Validator({ integer: true, range: [1, 50] })
  pageSize = 10;

  @Validator({ enumType: BookSort })
  sort: string = BookSort.Title;

  @Validator({ maxLength: 5 })
  authors: string[] = [];
}

export class LibraryHeaders {
  @FromHeader("x-library-id") @Validator({ required: true, uuid: true })
  libraryId!: string;
}
```

```ts
@Get("search")
search(query: FromQuery<BookSearchQuery>, library: FromHeader<LibraryHeaders>) {
  return this.books.search(query);
}
```

На полях `@FromQuery("…")` и `@FromHeader("…")` — уже декораторы: они
задают имя в запросе. Без них имя — имя свойства (для заголовка — без
учёта регистра).

```text
GET /catalog/search?q=du&page_size=5&authors=Herbert&authors=Lem   x-library-id: 0f8f…
→ query = {"q":"du","pageSize":5,"sort":"title","authors":["Herbert","Lem"]}

GET /catalog/search?q=du   X-Library-Id: 0f8f…
→ query = {"q":"du","pageSize":10,"sort":"title","authors":[]}

GET /catalog/search?q=d&page_size=abc&sort=price      (без заголовка)
→ 400 {"error":"Validation failed","details":[
    {"property":"page_size","message":"Field \"page_size\" must be of type number, got: string","code":"type"},
    {"property":"q","message":"Field \"q\" must be at least 2 characters long","code":"minLength"},
    {"property":"sort","message":"Field \"sort\" must be one of: title, year","code":"enum"},
    {"property":"x-library-id","message":"Field \"x-library-id\" is required","code":"required"}]}

GET /catalog/search?q=dune&page_size=5&page_size=50
→ 400 … {"property":"page_size","message":"Parameter \"page_size\" must be given once","code":"duplicate"}
```

- **Все ошибки — одним ответом:** модели строки запроса, модели заголовков,
  тела и одиночных параметров вместе. `property` — имя, как его прислал
  клиент.
- **Только объявленное.** Лишние параметры (`admin`, `__proto__`)
  игнорируются. Поле без значения сохраняет значение по умолчанию.
- **Повтор одиночного параметра — `400 duplicate`**, а не «взять первый»:
  прокси и приложение могли бы прочитать разные значения. В массиве — до
  100 значений (`tooManyValues`).
- **Типы полей:** `string`, `number`, `boolean` и массивы из них; у модели
  заголовков — одно значение на поле. Вложенный объект — ошибка при запуске:
  вложенные фильтры — задача [списков](../http/lists.md).
- **OpenAPI** показывает поля моделей параметрами `query` и `header` под
  их именами, с правилами и описаниями из JSDoc.
- `@RequestModel()` моделям не нужен — как и модели тела.

Ошибки использования ловит кодогенерация — `BAZIS_HTTP_BINDING_UNRESOLVED` с
причиной: `FromHeader<string[]>` (заголовок — одно значение), имя у модели
(`FromQuery<BookSearchQuery, "q">`), `FromRoute` с именем, которого нет в
шаблоне, `FromBody<string>`.

> [!NOTE]
> Явные источники и модели строки запроса и заголовков — с версии 0.101.0,
> все ошибки привязки одним ответом — с 0.102.0. Раньше `FromQuery` и другие
> были описателями убранного в 0.95 декоратора `@Bind`; теперь это типы и
> декораторы полей.

### `HttpContext`

Через контекст доступно всё остальное о запросе:

| Свойство или метод | Что даёт |
| --- | --- |
| `ctx.method`, `ctx.path`, `ctx.url` | Метод, путь, полный URL |
| `ctx.params` | Все параметры маршрута |
| `ctx.query(name)` | Значение из строки запроса |
| `ctx.header(name)` | Заголовок запроса; для проверяемого значения — `FromHeader` |
| `ctx.text()`, `ctx.formData()` | Тело как текст или форма |
| `ctx.request` | Исходный `Request` |
| `ctx.state` | Данные, которые middleware передают дальше по запросу |

## Ответы

Что вернул метод, то и уходит клиенту:

| Возвращаемое значение | Ответ |
| --- | --- |
| Объект или массив | `200`, JSON |
| Строка | `200`, `text/plain` |
| `undefined` | `204 No Content` |
| `Response` | Отправляется как есть |
| Результат помощника (`NotFound(...)` и др.) | Код и тело из помощника |

Методы могут быть асинхронными — возвращайте `Promise`.

Помощники из `bazis/core/http`:

| Помощник | Код |
| --- | --- |
| `Ok(body)` | 200 |
| `Created(location, body)` | 201 + заголовок `Location` |
| `Accepted(body)` | 202 |
| `NoContent()` | 204 |
| `BadRequest(body)` · `Unauthorized(body)` · `Forbidden(body)` · `NotFound(body)` · `Conflict(body)` | 400 · 401 · 403 · 404 · 409 |
| `InternalServerError(body)` | 500 |
| `Redirect(url, permanent?)` | 302, или 301 при `permanent = true` |
| `StatusCode(code, body)` | Любой код |
| `File(path \| Blob \| Uint8Array, contentType?)` | Файл; для пути — с поддержкой `Range` |

Код успешного ответа можно задать в декораторе вместо помощника:

```ts
@Post("import", { code: 202 })
startImport() { return { queued: true }; }
```

## Параметры маршрута в декораторе

Второй аргумент декоратора маршрута — объект настроек:

| Настройка | Что делает |
| --- | --- |
| `code` | Код успешного ответа |
| `produces` | `Content-Type` ответа для простых результатов |
| `consumes` | Обязательный `Content-Type` запроса для методов с телом |
| `maxBodySize` | Предельный размер тела, например `"4mb"` |
| `middleware` | Middleware только для этого метода |
| `version` | Версия API метода — см. [Версионирование API](../http/versioning.md) |

## Дальше

- [Маршрутизация и привязка параметров](../http/routing.md)
- [Модели запросов и валидация](validation.md)
- [Провайдеры и DI](providers.md)
