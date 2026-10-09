# OpenAPI

bazis сам описывает API в формате [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0):
адреса, параметры, тела запросов, ответы и ошибки. Описание строится из
кода при кодогенерации — Swagger-декораторов нет. Что написано в
сигнатуре метода и модели запроса, то и попадёт в документ.

Все примеры проверены на bazis 0.98.6.

## Где смотреть

| Адрес | Что там |
| --- | --- |
| `/docs` | Страница со списком операций, поиском и исходным документом |
| `/docs/openapi.json` | Сам документ — для Swagger UI, Scalar, Postman или генератора клиента |

По умолчанию документация включена в `development` (`bazis dev`) и
выключена в `production`. Настройка — опция `docs`:

```ts
await runApp(AppModule, {
  http: { port: 3000, docs: { path: "/api-docs", title: "Tasks API", version: "2.1.0" } },
});
```

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `docs: true` / `false` | По окружению | Включить или выключить |
| `enabled` | `true`, если передан объект | То же внутри объекта |
| `path` | `/docs` | Адрес страницы |
| `specPath` | `<path>/openapi.json` | Адрес документа |
| `title`, `version` | `Bazis API`, `1.0.0` | `info.title` и `info.version` документа |

Общий префикс `http: { prefix: "api" }` входит в пути операций
(`/api/tasks`), но не в адрес документации — она остаётся на `/docs`.

> [!WARNING]
> Документация отдаётся до middleware и проверок доступа приложения: кто
> может открыть сервер, тот может прочитать и описание API. В
> `production` она выключена; если включаете её там, закройте адрес на
> уровне прокси.

## Что попадает в документ

```ts
/** A task as the API returns it. */
export interface TaskResponse {
  id: string;
  /** Short title shown in lists. */
  title: string;
  done: boolean;
  priority?: "low" | "high";
  createdAt: Date;
}

@RequestModel()
export class CreateTaskRequest {
  @Validator({ required: true, minLength: 1, maxLength: 200 })
  title!: string;

  @Validator({ email: true })
  assignee?: string;
}

@Controller("tasks")
@Authorize(isAdmin)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /**
   * Returns one task.
   * Answers 404 when there is no such task.
   */
  @Get(":id(uuid)")
  @AllowAnonymous()
  async getById(id: string): Promise<TaskResponse> {
    const task = await this.tasks.getById(id);
    if (!task) throw new NotFoundError(`task ${id} not found`);
    return task;
  }

  @Post()
  create(body: CreateTaskRequest, ctx: HttpContext) {
    return Created(`${ctx.path}/${task.id}`, task);
  }
}
```

Что получается:

```text
GET  /tasks/{id}  200 404          summary: "Returns one task."
POST /tasks       201 400 401 403  summary: "POST /tasks"
```

### Параметры

| В коде | В документе |
| --- | --- |
| `:id` и `id: string` | `path`, строка |
| `:id(uuid)` / `(int)` / `(alpha)` | `format: uuid` / `integer` / `pattern` |
| `q: string` | `query`, обязательный |
| `limit = 10`, `tag?: string` | `query`, необязательный, тип по значению по умолчанию |
| `tag: string[]` | `query`, `array` |
| Модель списка (`ListRequest`) | `sort` со списком допустимых полей, `page[number]`, `page[size]` с `maximum`, `filter[поле][оператор]` |

### Тело запроса

Модель запроса становится схемой в `components.schemas`, правила
`@Validator` — ограничениями:

```json
"CreateTaskRequest": {
  "type": "object",
  "properties": {
    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
    "assignee": { "type": "string", "format": "email" }
  },
  "required": ["title"]
}
```

`min`/`max` → `minimum`/`maximum`, `email`/`uuid`/`url` → `format`.
`required` — поля с `required: true`.

### Ответ

Схема ответа берётся:

1. из **объявленного типа** метода — `getById(id): TaskResponse`,
   `Promise<TaskResponse[]>`;
2. если тип не объявлен — из того, что метод возвращает: переменной
   известного типа, литерала объекта, тела `Created(...)` или `Ok(...)`.

Именованный тип (`interface`, `class`) попадает в `components.schemas` и
подставляется ссылкой; `Date` — строка `date-time`, объединение строк
(`"low" | "high"`) — перечень значений. Объявляйте тип ответа явно: так
схема получает имя и описания полей, а не строится из случайного
литерала.

> [!NOTE]
> Объявленный тип важнее возвращаемого значения с версии 0.98.6. Раньше
> литерал в `return` давал безымянную схему даже при объявленном типе.

### Код успешного ответа

| В коде | Код |
| --- | --- |
| `@HttpCode(202)` или `@Post("...", { code: 202 })` | `202` — всегда важнее остального |
| `return Created(...)` | `201` |
| `return Accepted(...)` / `NoContent()` | `202` / `204` |
| `@Delete(...)` | `204` |
| Остальное | `200` |

Код из помощника берётся, если все успешные `return` метода используют
один и тот же помощник. Если метод в одной ветке возвращает
`Created(...)`, а в другой — обычный объект, в документе будет `200`.

### Ошибки

У ответов-ошибок общая схема `HttpErrorResponse` — тело, которое
действительно отправляет сервер:

```json
{ "error": "Validation failed", "details": [ ... ] }
```

| Откуда | Код |
| --- | --- |
| У метода есть тело, параметры строки запроса, модель списка или параметр пути с типом `number`/`boolean` | `400` |
| Метод под `@Authorize` | `401`, `403` |
| `return NotFound(...)`, `BadRequest(...)`, `Conflict(...)`, `StatusCode(409, ...)` в методе | соответствующий код |
| `throw new NotFoundError()` и другие ошибки HTTP в методе, в том числе свои наследники | соответствующий код |

Анализ видит только тело метода контроллера. Если `NotFoundError`
бросает сервис, в документе `404` не будет. Когда ошибка важна для
клиента, проверяйте результат в контроллере — как в `getById` выше.
Комментарий «Answers 404» сам по себе код ответа не добавляет.

> [!NOTE]
> Коды из помощников и ошибки — с версии 0.98.6. Раньше `Created(...)`
> описывался как `200`, а ошибок в документе не было.

## Описания из JSDoc

Комментарии в коде становятся описаниями в документе:

| Комментарий | Поле OpenAPI |
| --- | --- |
| Первая строка у метода контроллера | `summary` операции |
| Остальные строки | `description` операции |
| У `interface`, `class` | `description` схемы |
| У поля | `description` свойства |

Без комментария `summary` — метод и путь: `GET /tasks`.

> [!NOTE]
> JSDoc в документе — с версии 0.98.6.

## Прочее

| Что | Как |
| --- | --- |
| Группы (`tags`) | Первый сегмент префикса контроллера: `@Controller("tasks")` → `tasks` |
| `operationId` | Строится из метода и пути и не меняется при переименовании класса или метода |
| `produces: "text/csv"` | Тип содержимого ответа |
| Версии API | См. [Версионирование API](versioning.md#в-документации-api) |
| `@Authorize` | `security: bearerAuth` |

`@Authorize` всегда описывается схемой `bearerAuth` (заголовок
`Authorization: Bearer …`), даже если проверка смотрит на другой
заголовок или cookie. Своей схемы безопасности задать пока нельзя.

## Если документ не обновился

Описание строится кодогенерацией. `bazis dev`, `bazis test` и
`bazis build` запускают её сами. При запуске напрямую через
`bun src/index.ts` после правки JSDoc, типа ответа или тела метода
приложение запустится с предупреждением `generated code is out of date`,
а документ останется прежним — выполните `bazis codegen`. Подробнее — в
главе [Кодогенерация](../fundamentals/codegen.md).

## Дальше

- [Маршрутизация и привязка параметров](routing.md)
- [Модели запросов и валидация](../overview/validation.md)
- [Версионирование API](versioning.md)
