# CORS, заголовки безопасности, журнал запросов

Три встроенные части HTTP-сервера, которые настраиваются опциями `http`,
а не кодом контроллеров. Все три работают на **любом** ответе: ошибках
`401`, `404`, `500`, ответах `413` и `/health`.

```ts
await runApp(AppModule, {
  http: {
    port: 3000,
    cors: { origin: ["https://app.example.com"], credentials: true },
    securityHeaders: { hsts: true },
    accessLog: true,
    middleware: [createCorrelationIdMiddleware()],
  },
});
```

Все примеры проверены на bazis 0.98.8.

## CORS

Браузер не даёт странице с `https://app.example.com` читать ответы
`https://api.example.com`, пока сервер не разрешит это заголовками CORS.
Для запросов из `curl`, мобильного приложения или другого сервера CORS
не нужен.

### Разрешённые источники

| `origin` | Кому разрешено |
| --- | --- |
| не задан или `"*"` | Всем: `Access-Control-Allow-Origin: *` |
| `"https://app.example.com"` | Одному источнику |
| `["https://app.example.com", "https://admin.example.com"]` | Списку |
| `(origin) => origin.endsWith(".example.com")` | По функции |

Что видит браузер при `origin: ["https://app.example.com"]`:

| Запрос | Ответ |
| --- | --- |
| `Origin: https://app.example.com` | `200`, `Access-Control-Allow-Origin: https://app.example.com` |
| `Origin: https://evil.com` | `200` **без** заголовков CORS — браузер не отдаст ответ странице |
| Без `Origin` | Обычный ответ |

Сервер не отклоняет запрос с чужого источника — он выполняет его и не
добавляет разрешение. CORS защищает пользователя браузера, а не сервер:
проверку доступа он не заменяет.

Когда ответ зависит от источника, сервер добавляет `Vary: Origin`, чтобы
кэши не отдали ответ для одного источника другому.

### Предварительный запрос

Перед `POST` с JSON, запросом с заголовком `Authorization` или методом
`PUT`/`DELETE` браузер спрашивает разрешения: `OPTIONS` с заголовком
`Access-Control-Request-Method`. Сервер отвечает на него сам, до
маршрутизации:

```text
OPTIONS /tasks
Origin: https://app.example.com
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type

→ 204
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD
Access-Control-Allow-Headers: content-type
```

Для запрещённого источника ответ тоже `204`, но без заголовков CORS.

### Настройки

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `origin` | `"*"` | Разрешённые источники |
| `credentials` | `false` | Разрешить cookie и `Authorization` из браузера |
| `methods` | Все обычные методы | `Access-Control-Allow-Methods` |
| `allowedHeaders` | Те, что запросил браузер | `Access-Control-Allow-Headers` |
| `exposedHeaders` | — | Какие заголовки ответа доступны странице, например `["x-request-id"]` |
| `maxAgeSeconds` | — | Сколько браузер помнит ответ на preflight |

`credentials: true` вместе с `origin: "*"` (или без `origin`) — ошибка
при запуске: так любой сайт мог бы делать запросы с cookie пользователя.

```text
CORS credentials require an explicit origin allow-list or predicate.
Do not combine credentials: true with omitted origin or '*'.
```

### CORS для части маршрутов

Если чужим источникам открыта только часть API, вместо опции `cors`
поставьте middleware на контроллер или метод:

```ts
import { Controller, Middleware, cors } from "bazis/core/http";

@Controller("public")
@Middleware(cors({ origin: "*" }))
export class PublicController { ... }
```

Остальные маршруты остаются без CORS. `cors()` на методе важнее
`cors()` контроллера. Preflight-запрос к такому маршруту сервер тоже
отвечает сам — с настройками его `cors()`.

> [!NOTE]
> Ответ на preflight по `cors()` контроллера или метода — с версии
> 0.98.7. Раньше такой preflight получал `405`, и браузерный `POST` с
> JSON к маршруту не проходил.

## Заголовки безопасности

Включены по умолчанию на всех ответах:

| Заголовок | Значение | Зачем |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | Браузер не угадывает тип содержимого |
| `X-Frame-Options` | `DENY` | Страницу нельзя встроить во фрейм |
| `Referrer-Policy` | `no-referrer` | Адрес не уходит другим сайтам |
| `X-DNS-Prefetch-Control` | `off` | Нет предварительных DNS-запросов |

Настройки — опция `securityHeaders`:

```ts
securityHeaders: {
  frameOptions: "SAMEORIGIN",
  hsts: true,
  contentSecurityPolicy: "default-src 'self'",
  headers: { "permissions-policy": "camera=()" },
}
```

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `contentTypeOptions` | `true` | `X-Content-Type-Options` |
| `frameOptions` | `"DENY"` | `"SAMEORIGIN"` или `false` — не отправлять |
| `referrerPolicy` | `"no-referrer"` | Своё значение или `false` |
| `dnsPrefetchControl` | `"off"` | `"on"` или `false` |
| `hsts` | выключен | `true` → `max-age=15552000; includeSubDomains`; объект — `maxAgeSeconds`, `includeSubDomains`, `preload` |
| `contentSecurityPolicy` | выключен | Строка политики |
| `headers` | — | Любые дополнительные заголовки |

HSTS и CSP по умолчанию выключены: HSTS имеет смысл только по HTTPS
(часто его ставит прокси), а неверная CSP ломает страницы. Включайте их,
когда знаете нужное значение.

Если маршрут сам поставил заголовок, сервер его не перезаписывает:

```ts
@Get("embed")
embed(res: ResponseBuilder) {
  res.header("x-frame-options", "SAMEORIGIN");   // этот ответ можно встроить во фрейм
  return { ... };
}
```

`securityHeaders: false` отключает всё — например, если заголовки
ставит прокси.

## Журнал запросов

`accessLog: true` пишет строку на каждый запрос через логгер приложения:

```text
info: GET /tasks 200 0.5ms {"method":"GET","path":"/tasks","status":200,"durationMs":0.49,"requestId":"req-7"}
```

| Поле | Что это |
| --- | --- |
| `method`, `path` | Метод и путь **без** строки запроса — параметры с токенами в журнал не попадут |
| `status` | Итоговый код, в том числе после обработчика ошибок |
| `durationMs` | Время обработки до сотых долей миллисекунды |
| `requestId` | Correlation id, если подключён `createCorrelationIdMiddleware()` |

В журнал попадают все запросы, включая `404`, `413`, preflight и
`/health`. Пропустить лишние:

```ts
accessLog: { skip: (ctx) => ctx.path === "/health" }
```

Свой приёмник вместо логгера:

```ts
accessLog: { log: (entry) => metrics.observe(entry.path, entry.status, entry.durationMs) }
```

`entry` — объект с теми же полями: `{ method, path, status, durationMs, requestId? }`.

`createCorrelationIdMiddleware()` в глобальных `middleware` добавляет
`x-request-id` ко всем ответам сервера: к ошибкам `401`/`403`/`500`, к
брошенной `NotFoundError` и к ответам, которые отдаются до
маршрутизации, — `404`, `405`, `413`, preflight. Клиент может прислать
свой `x-request-id`, и по нему запрос найдётся в журнале. Подробнее — в
главе [Логирование и correlation id](../fundamentals/logging.md#correlation-id).

> [!NOTE]
> Correlation id у ответов `404`/`405`/`413` и preflight, а также
> округление `durationMs` — с версии 0.98.7, у ответов-ошибок — с 0.98.8.
> Раньше `x-request-id` был только у успешных ответов маршрутов, а время
> выглядело как `1.3119999999999834`.

## Порядок

Встроенные части стоят снаружи всего остального:

```text
журнал запросов → CORS → заголовки безопасности → correlation id → обработчик ошибок → глобальные middleware → маршрут
```

Поэтому журнал видит итоговый код ответа, а CORS, заголовки
безопасности и `x-request-id` добавляются и к ответам, которые
сформировал обработчик ошибок. `createCorrelationIdMiddleware()`
встаёт на своё место сам, где бы он ни стоял в списке `middleware`.

## Дальше

- [Middleware](../overview/middleware.md)
- [Логирование и correlation id](../fundamentals/logging.md)
- [Ограничение частоты запросов](rate-limit.md)
