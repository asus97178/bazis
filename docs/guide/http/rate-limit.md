# Ограничение частоты запросов

`rateLimit` ограничивает, сколько запросов клиент может сделать за окно
времени. Лишние получают `429 Too Many Requests`, а не нагружают сервер
и не перебирают пароли.

Все примеры проверены на bazis 0.108.0.

## На всё приложение

```ts
import { rateLimit } from "bazis/core/http";

await runApp(AppModule, {
  http: { port: 3000, middleware: [rateLimit({ windowMs: 60_000, max: 100 })] },
});
```

100 запросов в минуту с одного IP-адреса:

```text
GET /tasks → 200   RateLimit-Limit: 100, RateLimit-Remaining: 99, RateLimit-Reset: 60
...
GET /tasks → 429   Retry-After: 42, RateLimit-Remaining: 0
{"error":"Too Many Requests"}
```

| Заголовок | Что значит |
| --- | --- |
| `RateLimit-Limit` | Сколько запросов разрешено за окно |
| `RateLimit-Remaining` | Сколько осталось |
| `RateLimit-Reset` | Через сколько секунд окно начнётся заново |
| `Retry-After` | Только у `429`: через сколько секунд повторить |

Заголовки `RateLimit-*` есть у каждого ответа, чтобы клиент мог
сбавить темп до отказа. Отключить их — `headers: false`.

> [!NOTE]
> Заголовки `RateLimit-*` — с версии 0.98.9. Раньше о лимите сообщал
> только ответ `429`.

## На отдельный маршрут

Строгий лимит обычно нужен не везде, а на входе, восстановлении пароля,
отправке писем:

```ts
@Post("login")
@Middleware(rateLimit({ windowMs: 60_000, max: 5 }))
login(body: LoginRequest) { ... }
```

У каждого `rateLimit(...)` свои счётчики. Запрос к `login` проходит
через оба лимита и учитывается в обоих — в том числе отклонённый
лимитом маршрута. Заголовки `RateLimit-*` в таком ответе показывают
лимит маршрута.

## Кого считать

По умолчанию ключ — IP-адрес клиента. Свой ключ — функция `keyOf`:

```ts
rateLimit({ windowMs: 60_000, max: 1000, keyOf: (ctx) => ctx.header("x-api-key") ?? "anonymous" })
```

Лимит по пользователю ставьте на маршрут под `@Authorize`: middleware
маршрута выполняется после проверки доступа, и пользователь уже известен.

```ts
const signedIn: AuthorizeCheck = (ctx) => {
  const user = readUser(ctx);            // ваш разбор токена
  if (!user) throw new UnauthorizedError();
  ctx.state.set("userId", user.id);
  return true;
};

@Get("reports")
@Authorize(signedIn)
@Middleware(rateLimit({ windowMs: 60_000, max: 10, keyOf: (ctx) => String(ctx.state.get("userId")) }))
reports() { ... }
```

Глобальный `rateLimit` выполняется **до** `@Authorize` (см.
[порядок middleware](../overview/middleware.md)) — в нём пользователя ещё нет.

## За прокси

За nginx, балансировщиком или CDN сервер видит не клиента, а прокси.
Лимит считается по `ctx.clientIp`, поэтому достаточно указать серверу
доверенные прокси — `http.trustedProxies`
([За nginx](../deployment/production.md#за-nginx)):

```ts
http: { trustedProxies: ["127.0.0.1"] }
```

Тогда у каждого клиента свой лимит, а поддельный `X-Forwarded-For` от
клиента, который пришёл в обход прокси, не учитывается.

> [!WARNING]
> С версии 0.120.0 у `rateLimit` нет `trustProxy` и `proxyHeader`:
> они считали адреса с конца заголовка и не проверяли, откуда пришло
> соединение. Старые параметры останавливают запуск:
> `rateLimit trustProxy was removed: list the proxies in http.trustedProxies (for example ["127.0.0.1"] for nginx); rateLimit then keys by ctx.clientIp.`

## Как считается

- **Фиксированное окно.** Счётчик ключа обнуляется через `windowMs`
  после первого запроса. На стыке окон клиент может успеть сделать до
  `2 × max` запросов подряд.
- **Память процесса.** Счётчики живут в процессе и пропадают при
  перезапуске. У нескольких экземпляров приложения лимиты свои — общий
  лимит на кластер делайте на прокси или своим middleware с общим
  хранилищем.
- **Ограничение памяти.** Счётчиков не больше `maxBuckets` (по умолчанию
  10 000). Когда места нет, новые ключи получают `429`, пока не освободится
  окно; у уже известных ключей лимит не сбрасывается.
- **Что не считается.** Запросы, на которые сервер отвечает до
  маршрутизации: `404` по неизвестному пути, `405`, `413`, preflight,
  `/health`, `/docs`.

## Настройки

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `windowMs` | — | Длина окна в миллисекундах |
| `max` | — | Сколько запросов разрешено за окно |
| `keyOf` | `ctx.clientIp` | Кого считать |
| `maxBuckets` | 10 000 | Сколько разных ключей помнить |
| `headers` | `true` | Заголовки `RateLimit-*` в ответах |

Неверные значения — ошибка при запуске: `rateLimit max must be a
positive integer.`

## Дальше

- [Middleware](../overview/middleware.md)
- [Авторизация](../overview/authorization.md)
- [Кэширование ответов](output-cache.md)
