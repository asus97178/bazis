# `bazis/core/http`

HTTP-слой: контроллеры, маршруты, привязка аргументов, ответы, ошибки,
middleware, авторизация, списки. Основная точка входа для кода
контроллеров.

Список — по пакету 0.116.0.

## Контроллеры и маршруты

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Controller(path?)` | Декоратор класса-контроллера с общим путём | [Контроллеры](../../overview/controllers.md) |
| `Get`, `Post`, `Put`, `Patch`, `Delete`, `Head`, `Options`, `All` | Декораторы маршрутов; `All` — любой метод, с наименьшим приоритетом | [Маршрутизация](../../http/routing.md) |
| `HttpCode(code)` | Код успешного ответа метода | [Контроллеры](../../overview/controllers.md#параметры-маршрута-в-декораторе) |
| `Produces(contentType)` | `Content-Type` ответа для простых значений | там же |
| `Consumes(contentType)` | Обязательный `Content-Type` запроса; иначе `415` | там же |
| `ApiVersion(version)` | Версия API контроллера или метода | [Версии API](../../http/versioning.md) |
| `Middleware(...middleware)` | Middleware на контроллер или метод | [Middleware](../../overview/middleware.md) |
| `ActionFilter({ before, after })` | Код до и после метода; `after` может заменить результат | [Фильтры действий](../../overview/middleware.md#фильтры-действий) |
| `Catch(ErrorType?)` | Метод контроллера — обработчик ошибок этого типа (по `instanceof`) | — |

## Аргументы

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `FromQuery<T, Name>`, `FromHeader<T, Name>`, `FromBody<T>`, `FromRoute<T, Name>` | Типы-маркеры источника аргумента; кодогенерация читает их из сигнатуры | [Явный источник](../../overview/controllers.md#явный-источник-fromquery-fromheader-frombody-fromroute) |
| `FromQuery(name)`, `FromHeader(name)` | Декораторы полей модели строки запроса и заголовков: имя в запросе | [Модели строки запроса](../../overview/controllers.md#модели-строки-запроса-и-заголовков) |
| `RequestModel()` | Помечает класс моделью запроса. Нужен только классу из другого пакета | [Проверка данных](../../overview/validation.md) |
| `HttpContext` | Контекст запроса: путь, параметры, заголовки, тело, `state`, `services` | [`HttpContext`](../../overview/controllers.md#httpcontext) |
| `ResponseBuilder` | Код и заголовки ответа до того, как он собран | [Ответы](../../overview/responses.md#код-и-заголовки-responsebuilder) |

## Ответы

| Экспорт | Что это |
| --- | --- |
| `Ok`, `Created`, `Accepted`, `NoContent` | `200`, `201` (с `Location`), `202`, `204` |
| `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `InternalServerError` | Ответы с кодом ошибки и телом |
| `Redirect(location, permanent?)` | `302`, с `permanent` — `301` |
| `StatusCode(status, body?)` | Любой код с JSON-телом |
| `File(pathOrBlob, contentType?)` | Файл по пути, `Blob` или байты; запросы `Range` работают сами |
| `HttpResult` | Базовый класс результатов: рецепт итогового `Response` |

Подробно — [Ответы](../../overview/responses.md), [Файлы](../../http/files.md).

## Ошибки

| Экспорт | Что это |
| --- | --- |
| `HttpError` | Базовая ошибка с кодом ответа; превращается в `{ error, details? }` |
| `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError` | `400`, `401`, `403`, `404` |
| `MethodNotAllowedError`, `PayloadTooLargeError`, `UnsupportedMediaTypeError`, `TooManyRequestsError` | `405`, `413`, `415`, `429` |
| `ModelValidationError` | `400 Validation failed` со списком ошибок привязки и проверки |
| `HttpSetupError` | Ошибка маршрутов при запуске |
| `EN_HTTP_MESSAGES`, `RU_HTTP_MESSAGES` | Каталоги текстов HTTP-слоя по ключам |
| `markUpstreamFailure(error, kind)`, `upstreamFailure(error)` | Пометка ошибки внешнего вызова: необработанная даёт `502` или `504` |

Подробно — [Ошибки](../../overview/errors.md), [справочник ошибок HTTP](../errors/http.md).

## Middleware

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `cors(options)` | CORS: заголовки и ответы на предварительные запросы | [CORS](../../http/cors-headers-log.md#cors) |
| `securityHeaders(options)` | Заголовки безопасности; сервер ставит его сам | [CORS, заголовки, журнал](../../http/cors-headers-log.md) |
| `accessLog(options)` | Журнал запросов: метод, путь, статус, время | [Журнал](../../fundamentals/logging.md#журнал-запросов) |
| `rateLimit(options)` | Ограничение частоты в памяти, окно фиксированное | [Ограничение частоты](../../http/rate-limit.md) |
| `createCorrelationIdMiddleware(options)` | Один `x-request-id` на запрос: в ответе, в журнале, в исходящих вызовах | [Correlation id](../../fundamentals/logging.md#correlation-id) |
| `errorHandler(options)` | Граница ошибок; сервер ставит её сам, настраивается через `http.errorHandler` | [Ошибки](../../overview/errors.md) |

## Авторизация

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Authorize(...checks)` | Проверки доступа на контроллер или метод; все должны пройти | [Авторизация](../../overview/authorization.md) |
| `AllowAnonymous()` | Открытый метод: снимает все проверки, и контроллера тоже | [Класс, метод и `@AllowAnonymous`](../../overview/authorization.md#класс-метод-и-allowanonymous) |
| `anyOf(...checks)` | Проверка «хотя бы одна из» | [«Или»](../../security/authorization-patterns.md#или-anyof) |
| `bearerToken(ctx)` | Токен из `Authorization: Bearer …` или `undefined` | [JWT](../../security/jwt.md#проверка-в-authorize) |
| `PRINCIPAL_STATE_KEY` | Ключ `ctx.state`, под которым лежит текущий пользователь | там же |

## Списки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `ListRequest` | Базовый класс модели списка | [Списки](../../http/lists.md) |
| `ListOptions(options)`, `Sortable()`, `Filterable(...operators)` | Пределы страниц, сортировка, фильтры модели списка | там же |
| `buildListDocument(items, query, total, options)` | Ответ-коллекция: `data`, `meta`, `links` | [Ответ](../../http/lists.md#ответ) |
| `serializeListQuery(query)` | Строка запроса из `ListQuery` | там же |

## Для пакетов и сгенерированного кода

Приложению они обычно не нужны.

| Экспорт | Что это |
| --- | --- |
| `httpModule(options)`, `HttpServer` | HTTP-модуль и сервер; `runApp({ http })` создаёт их сам |
| `SERVER_MIDDLEWARE`, `ROUTE_MIDDLEWARE_COMPOSER`, `HTTP_ERROR_HOOK` | Токены, через которые пакет добавляет свой middleware или обработчик ошибок |
| `composeRouteMiddlewareComposers`, `createAuthorizeComposer`, `resolveAuthorizeMeta`, `sortByOrder` | Сборка middleware маршрута |
| `WEBSOCKET_UPGRADE` | Токен: WebSocket на порту HTTP-сервера |
| `registerRequestModelClass`, `registerRequestModelShape`, `findRequestModelByName`, `findRequestModelShape`, `AMBIGUOUS_REQUEST_MODEL` | Реестр моделей запроса; заполняет сгенерированный код |
| `useModelValidator`, `getModelValidator` | Валидатор моделей; подключает `runApp` |

## Типы

- **Маршруты и аргументы:** `RouteOptions`, `RouteParams`, `BindingSource`,
  `ParameterBinding`, `ValueType`, `FromBody`, `FromRoute`.
- **Модели запроса:** `ModelValidator`, `ModelValidationIssue`,
  `RequestModelClass`, `RequestModelShape`, `RequestModelFieldShape`,
  `RequestModelPrimitive`, `RequestModelPrimitiveFieldShape`,
  `RequestModelNestedFieldShape`.
- **Middleware:** `HttpMiddleware`, `ActionFilterHooks`, `CorsOptions`,
  `SecurityHeadersOptions`, `HstsOptions`, `AccessLogOptions`,
  `AccessLogEntry`, `RateLimitOptions`, `CorrelationIdMiddlewareOptions`,
  `RouteMiddlewareComposer`, `RouteMiddlewareComposerRegistration`,
  `ServerMiddlewareRegistration`.
- **Ошибки и тексты:** `ErrorHandlerOptions`, `HttpErrorHook`,
  `UpstreamFailure`, `HttpMessageKey`, `Localize`, `LocalizedMessage`.
- **Авторизация:** `AuthorizeCheck`, `AuthorizeContext`, `AuthorizeOptions`,
  `ResolvedAuthorizeMeta`, `RequestPrincipal`.
- **Сервер:** `HttpModuleOptions`, `HealthEndpointOptions`,
  `ApiVersioningOptions`, `OpenApiDocsOptions`, `WebSocketUpgrade`.
- **Списки:** `ListQuery`, `ListDocument`, `BuildListDocumentOptions`,
  `FilterOperator`.

Параметры `HttpModuleOptions` — в [Параметрах конфигурации](../configuration.md#http).
