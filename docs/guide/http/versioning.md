# Версионирование API

Когда ответ метода меняется несовместимо — поле переименовали, формат
поменялся, — старые клиенты ломаются. Версии позволяют держать старый и
новый варианты рядом: клиент сам выбирает, какой ему нужен.

Все примеры проверены на bazis 0.98.5.

## Версия контроллера

```ts
import { ApiVersion, Controller, Get } from "bazis/core/http";

@Controller("tasks")
@ApiVersion("1")
export class TasksV1Controller {
  @Get(":id")
  getById(id: string) { return { id, title: "Buy milk" }; }
}

@Controller("tasks")
@ApiVersion("2")
export class TasksV2Controller {
  @Get(":id")
  getById(id: string) { return { id, name: "Buy milk", done: false }; }
}
```

Оба контроллера подключаются в модуле как обычно. Версия — строка:
`"1"`, `"2.0"`, `"2026-10"` — какая удобна.

Как клиент указывает версию, задаёт опция `versioning` в настройках HTTP.
Без неё версия — часть пути.

## Версия в пути

```text
GET /v1/tasks/7 → {"id":"7","title":"Buy milk"}
GET /v2/tasks/7 → {"id":"7","name":"Buy milk","done":false}
GET /tasks/7    → 404
GET /v9/tasks/7 → 404
```

Сегмент `v<версия>` встаёт перед префиксом контроллера, но после общего
префикса приложения: при `http: { prefix: "api" }` адрес —
`/api/v1/tasks/7`. Контроллеры без `@ApiVersion` версии в пути не имеют:
`/api/ping`.

Каждая версия — отдельный набор адресов. Если в `TasksV2Controller` нет
метода списка, `GET /v2/tasks` — `404`: к версии 1 запрос не уйдёт.

Это вариант по умолчанию, и обычно лучший: версию видно в адресе, её
понимают прокси и кэши, ссылку можно скопировать и открыть.

## Версия в строке запроса или заголовке

Когда адреса должны оставаться одинаковыми для всех версий, версию
передают параметром или заголовком:

```ts
await runApp(AppModule, {
  http: { port: 3000, versioning: { source: "query", defaultVersion: "1" } },
});
```

| Настройка | Запрос |
| --- | --- |
| `{ source: "query" }` | `GET /tasks/7?api-version=2` |
| `{ source: "query", parameterName: "v" }` | `GET /tasks/7?v=2` |
| `{ source: "header" }` | `GET /tasks/7` с заголовком `x-api-version: 2` |
| `{ source: "header", headerName: "x-version" }` | заголовок `x-version: 2` |

Что получает клиент:

| Запрос | Ответ |
| --- | --- |
| `?api-version=1` | Версия 1 |
| `?api-version=2` | Версия 2 |
| Без версии, есть `defaultVersion: "1"` | Версия 1 |
| Без версии и без `defaultVersion` | `400` |
| `?api-version=9` | `400` |
| `/ping?api-version=9` — маршрут без `@ApiVersion` | `200`: такой маршрут отвечает на любую версию |

```json
{"error":"Unsupported API version","details":{"supported":["1","2"]}}
```

В `supported` — версии, которые есть **у этого адреса**: для `/tasks`,
который объявлен только в версии 1, это `["1"]`.

Версии сравниваются как строки, без разбора чисел: `1.0` и `v1` — не то
же самое, что `1`, и получат `400`. Договоритесь об одном написании и
указывайте его в документации API.

### Настройки, которые ни на что не влияют

Приложение не запустится, если настройка не подходит к выбранному
источнику:

```text
versioning.defaultVersion has no effect with source "url": the version is part of the path (/v1/...).
Remove it, or use source "query" or "header".
```

То же для `parameterName` без `source: "query"`, `headerName` без
`source: "header"` и неизвестного `source`.

> [!NOTE]
> Проверка — с версии 0.98.4. Раньше такие настройки молча
> игнорировались: с `{ source: "url", defaultVersion: "1" }` адрес
> `/tasks/7` отвечал `404`.

## Общий код версий

Обычно новая версия меняет несколько методов, а остальные остаются
прежними. Общие методы вынесите в абстрактный базовый класс, а каждая
версия добавит своё:

```ts
abstract class NotesController {
  constructor(protected readonly notes: NotesService) {}

  @Get()
  getAll(limit = 20) { return this.notes.getAll(limit); }

  @Delete(":id")
  delete(id: string) { return this.notes.delete(id); }
}

@Controller("notes")
@ApiVersion("1")
export class NotesV1Controller extends NotesController {
  @Get(":id")
  getById(id: string) { return toNoteV1(this.notes.getById(id)); }
}

@Controller("notes")
@ApiVersion("2")
export class NotesV2Controller extends NotesController {
  @Get(":id")
  getById(id: string) { return toNoteV2(this.notes.getById(id)); }
}
```

```text
GET    /v1/notes   и /v2/notes    → getAll из базового класса
DELETE /v1/notes/7 и /v2/notes/7  → delete из базового класса
GET    /v1/notes/7                → формат версии 1
GET    /v2/notes/7                → формат версии 2
```

Маршруты, параметры и зависимости конструктора наследуются. Базовый
класс не регистрируется в модуле и не получает `@Controller` — у него
нет своих адресов.

Можно наследовать и одну версию от другой:
`NotesV2Controller extends NotesV1Controller`. Тогда:

| В версии 2 | Что получается |
| --- | --- |
| Метод не переопределён | Маршрут и реализация версии 1 |
| Переопределён без декоратора маршрута | Маршрут версии 1, реализация версии 2 |
| Переопределён со своим `@Get(...)` | Маршрут версии 2 **заменяет** маршрут версии 1 |

Ограничение даёт TypeScript: переопределённый метод должен возвращать
совместимый тип. Если версия 2 меняет формат ответа — а ради этого
обычно и заводят версию, — `override` не скомпилируется
(`TS2416 … is not assignable to the same property in base type`). Для
таких методов подходит общий базовый класс из примера выше.

> [!NOTE]
> Наследование маршрутов работает с версии 0.98.5. Раньше маршрут
> потомка добавлялся к маршруту родителя, и приложение не запускалось с
> ошибкой `Duplicate route`. Кроме того, унаследованные методы получали
> `HttpContext` вместо своих параметров.

## Версия метода

`@ApiVersion` можно поставить и на метод — он перекрывает версию
контроллера. То же делает опция маршрута `version`:

```ts
@Controller("tasks")
@ApiVersion("2")
export class TasksV2Controller {
  @Get(":id")
  getById(id: string) { ... }

  @Get("stats")
  @ApiVersion("3")            // или @Get("stats", { version: "3" })
  stats() { ... }
}
```

```text
GET /v3/tasks/stats → stats
GET /v2/tasks/stats → getById с id = "stats"
```

Метод версии 3 «уехал» на `/v3/...`, и в версии 2 адрес
`/v2/tasks/stats` достался шаблону `:id`. Если такой адрес не должен
совпадать с идентификатором, ограничьте параметр: `:id(uuid)` или
`:id(int)`.

## Какую версию обрабатывает метод

`ctx.apiVersion` — версия, объявленная у метода: `"1"` в
`TasksV1Controller`, `"3"` в `stats`. У маршрута без `@ApiVersion` —
`undefined`, даже если клиент прислал `?api-version=9`. Это версия
обработчика, а не то, что написал клиент.

## Одинаковые маршруты

Два метода с одним адресом и одной версией — ошибка при запуске:

```text
Duplicate route: GET /tasks/:taskId (version 1) is mapped to both TasksV1Controller.getById (/tasks/:id)
and TasksDupController.again. Routes that differ only in parameter names are the same route; change one of the paths.
```

## В документации API

В OpenAPI при версии в пути у каждой версии свои пути: `/v1/tasks/{id}`,
`/v2/tasks/{id}`. При версии в строке запроса или заголовке путь один, а
у операции появляется параметр версии со списком допустимых значений:

```json
{"name":"api-version","in":"query","required":false,"schema":{"type":"string","enum":["1","2"]}}
```

`required` — `false`, если задан `defaultVersion`. Список версий
операции есть и в поле `x-bazis-versions`.

## Дальше

- [Маршрутизация и привязка параметров](routing.md)
- [Контроллеры](../overview/controllers.md)
- OpenAPI *(в работе)*
