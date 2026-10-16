# Ошибки HTTP

Три группы ошибок:
- [ответы клиенту](#ответы-клиенту) — ошибки, которые становятся HTTP-ответом;
- [ошибки маршрутов](#ошибки-маршрутов-при-запуске), из-за которых сервер
  не запускается;
- [ошибки HTTP-клиента](#http-клиент) — когда приложение само ходит во
  внешний сервис.

Тексты получены на bazis 0.100.7.

## Ответы клиенту

Любая `HttpError`, брошенная в контроллере, сервисе или middleware,
становится ответом `{ "error": "…", "details": … }` с её статусом. Классы —
из `bazis/core/http`.

| Класс | Статус | Текст по умолчанию | С `language: "ru"` |
| --- | --- | --- | --- |
| `BadRequestError` | 400 | `Bad Request` | `Некорректный запрос` |
| `UnauthorizedError` | 401 | `Unauthorized` | `Требуется аутентификация` |
| `ForbiddenError` | 403 | `Forbidden` | `Доступ запрещён` |
| `NotFoundError` | 404 | `Not Found` | `Не найдено` |
| `MethodNotAllowedError` | 405 | `Method Not Allowed` | `Метод не поддерживается` |
| `PayloadTooLargeError` | 413 | `Payload Too Large` | `Слишком большой запрос` |
| `UnsupportedMediaTypeError` | 415 | `Unsupported Media Type: expected application/json` | `Неподдерживаемый тип содержимого: ожидается application/json` |
| `TooManyRequestsError` | 429 | `Too Many Requests` | `Слишком много запросов` |
| `ModelValidationError` | 400 | `Validation failed` | `Проверка данных не пройдена` |

- Свой текст — первым аргументом: `new NotFoundError("Книга 99 не
  найдена", { id: 99 })`. Он не переводится.
- `UnauthorizedError` добавляет заголовок `WWW-Authenticate: Bearer`,
  `TooManyRequestsError` — `Retry-After`, `MethodNotAllowedError` — `Allow`.
- Перевод текстов — в рецепте [Русская локализация](../../recipes/russian.md).

### Что фреймворк отвечает сам

| Ситуация | Статус | Текст |
| --- | --- | --- |
| Маршрута нет | 404 | `Not Found` |
| Маршрут есть, метода нет | 405 | `Method Not Allowed` |
| Параметр маршрута не прошёл ограничение (`/books/abc` для `:id(int)`) | 404 | `Not Found` |
| Нет обязательного параметра строки запроса | 400 | `Missing required query parameter "q"` |
| Параметр не того типа | 400 | `Parameter "limit" must be of type number, got: "x"` |
| Тело — не JSON | 400 | `Malformed JSON in request body` |
| Тело — JSON, но не объект | 400 | `Request body must be a JSON object` |
| Тело не прошло проверку | 400 | `Validation failed` и список в `details` |
| Тело больше `maxBodyBytes` | 413 | `Payload Too Large`, в `details` — `maxBytes` |
| Нет входа (`@Authorize`) | 401 | `Unauthorized` |
| Нет прав (`@Authorize`) | 403 | `Forbidden` |
| Превышен `rateLimit` | 429 | `Too Many Requests` |
| Неподдерживаемая версия API | 400 | `Unsupported API version`, в `details` — `supported` |

### `ModelValidationError`

```json
{
  "error": "Validation failed",
  "details": [
    { "property": "title", "message": "Field \"title\" must be at least 1 characters long", "code": "minLength" },
    { "property": "year", "message": "Field \"year\" must be of type number, got: string", "code": "type" }
  ]
}
```

- `property` — путь к полю: `address.city`, `items[2].qty`.
- `code` — правило: `required`, `minLength`, `type`, `unknownField`…
  Клиенту удобнее ветвиться по нему, а не по тексту.
- Все коды — в главе [Проверка данных](../../overview/validation.md).

### Непредвиденные ошибки

Любая ошибка, кроме `HttpError`, — это `500`:

```json
{ "error": "Internal Server Error" }
```

- В `development` в ответ добавляются `message` и `stack`, в `production` —
  нет. Ошибка пишется в журнал строкой `error: GET /books/1 failed {…}`.
- Ошибка внешнего вызова через `HttpClient` — `502 Bad Gateway`, тайм-аут —
  `504 Gateway Timeout`.
- Свой статус для класса ошибки — опция `errorHandler.status`, например
  ошибки базы данных → `409`, `503`
  ([Ошибки базы данных](../../database/errors.md)).
- Подробно — в главе [Ошибки](../../overview/errors.md).

## Ошибки маршрутов при запуске

### `HttpSetupError`

Маршруты не собрались — сервер не стартует:

```text
[bazis] application failed: HttpSetupError: Duplicate route: GET /orders/:orderId is mapped to both OrdersController.byId (/orders/:id) and OrdersController.byOrderId. Routes that differ only in parameter names are the same route; change one of the paths.
```

| Текст | Что сделать |
| --- | --- |
| `Duplicate route: GET /orders/:orderId is mapped to both …` | `:id` и `:orderId` — один и тот же маршрут; поменяйте путь одного из методов |
| `Unknown route constraint "(integer)" in template "invoices/:id(integer)". Known: int, number, bool, uuid, alpha.` | Ограничение из списка |
| `Class "PlainClass" is not a controller. Add @Controller() and route decorators.` | В `controllers` модуля — класс без `@Controller` |
| `FixtureController.get has parameters but no generated argument bindings: the generated code is older than this controller. Run \`bazis codegen\` …` | Сгенерированный код устарел: `bunx bazis codegen` |
| `Invalid route parameter "…" in template "…"` | Текст из исходников: параметр без имени (`/:`) |
| `Wildcard "*" must be the last segment in template "…"` | Текст из исходников: `*` только в конце пути |
| `HTTP route maxBodySize must match '<positive integer><b\|kb\|mb\|gb>' (e.g. '4mb').` | Текст из исходников: размер в виде `"4mb"` |

> [!NOTE]
> Ошибки маршрутов — ошибки кода, но печатаются как `application failed`,
> а не `configuration error`.

## HTTP-клиент

### `HttpClientError`

Класс из `bazis/core/http-client`. Поле `code` — стабильный код, поле
`status` — статус ответа, если ответ был:

| `code` | Текст | Когда |
| --- | --- | --- |
| `ERR_BAD_STATUS` | `Request failed with status 503` | Статус не прошёл `validateStatus` (по умолчанию — не 2xx). Ответ — в `error.response` |
| `ETIMEDOUT` | `Request timed out after 300ms` | Вышел `timeoutMs` |
| `ERR_NETWORK` | `Unable to connect. Is the computer able to access the url?` | Нет соединения: адрес недоступен, DNS, сброс |
| `ERR_BAD_RESPONSE` | `Response contains invalid JSON` | Ответ с `application/json` не разбирается |
| `ERR_RESPONSE_TOO_LARGE` | `Response exceeded 1000 bytes` | Ответ больше `maxResponseBytes` |
| `ERR_CANCELED` | `Request canceled` | Запрос отменён через `signal` |
| `ERR_TOO_MANY_REDIRECTS` | — | Цепочка перенаправлений длиннее `maxRedirects` |
| `ERR_REDIRECT_NOT_INSPECTABLE`, `ERR_REDIRECT_BODY_NOT_REPLAYABLE` | — | Перенаправление нельзя безопасно повторить ([HTTP-клиент](../../http/http-client.md)) |

```ts
try {
  await http.get("/rates");
} catch (error) {
  if (error instanceof HttpClientError && error.code === HttpErrorCode.Timeout) {
    // retry later
  }
  throw error;
}
```

Ошибка настройки клиента — без `code`, с подсказкой:

```text
HttpClientError: baseUrl "x" is relative: outside a browser page it must be absolute, for example "http://localhost:3000/x"
```

> [!WARNING]
> Опция называется `baseUrl`, а не `baseURL`, как в axios. С `baseURL` она
> молча не применяется, и каждый запрос падает с `ERR_NETWORK` и текстом
> `fetch() URL is invalid`.

### `HttpClientConfigError`

```text
HttpClient "payments" is not configured (known clients: rates)
```

Текст из исходников. Запрошен именованный клиент, которого нет в
`httpClientModule` ([Несколько внешних сервисов](../../http/http-client.md#несколько-внешних-сервисов)).

## Дальше

- [Ошибки](../../overview/errors.md)
- [HTTP-клиент](../../http/http-client.md)
- [Ошибки запуска и конфигурации](startup.md)
