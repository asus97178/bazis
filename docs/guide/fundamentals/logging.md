# Логирование и correlation id

В bazis один журнал на всё приложение: строки ваших сервисов, журнал
запросов, ошибки HTTP и фоновых служб пишутся одним логгером и в одном
формате. Correlation id связывает их с запросом, к которому они относятся.

Все примеры проверены на bazis 0.97.11.

## Логгер в сервисе

Логгер внедряется по типу `Logger`:

```ts
import type { Logger } from "bazis/core/kernel";

export class PaymentService {
  constructor(private readonly logger: Logger) {}

  async pay(amount: number) {
    this.logger.debug("checking limits", { amount });
    // ...
    this.logger.info("payment accepted", { amount });
  }
}
```

Четыре уровня — `debug`, `info`, `warn`, `error`. Первый аргумент —
сообщение, второй — поля: объект, который попадёт в строку как JSON.

```text
debug: checking limits {"amount":50,"requestId":"req-7"}
info: payment accepted {"amount":50,"requestId":"req-7"}
```

Пишите подробности полями, а не внутри сообщения: так строки удобно
фильтровать в системе сбора журналов.

## Уровни

Стандартный логгер показывает:

| Окружение | С какого уровня |
| --- | --- |
| `development`, `test` | `debug` |
| `production` | `info` |

Свой порог, имя приложения в начале строки и другие настройки задаются
своим экземпляром `ConsoleLogger`:

```ts
import { ConsoleLogger } from "bazis/core/kernel";

await runApp(AppModule, {
  http: { port: 3000 },
  configure: (kernel) => kernel.useLogger(new ConsoleLogger({ minLevel: "info", name: "shop" })),
});
```

```text
[shop] info: payment accepted {"amount":5,"requestId":"7353…"}
```

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `minLevel` | Зависит от окружения | Самый низкий выводимый уровень |
| `name` | — | Префикс `[name]` в каждой строке |
| `redaction` | Включена | Маскировка секретов; `false` — только для отладки на своей машине |
| `requestContext` | `true` | Добавлять `requestId` внутри запроса |

## Маскировка секретов

Поля, в имени которых есть `password`, `passphrase`, `secret`, `token`,
`apiKey`, `authorization`, `cookie`, `privateKey`, `credential` или
`sessionId`, заменяются на `***` — на любой глубине вложенности (так что
`dbPassword` и `accessToken` тоже):

```ts
this.logger.info("payment accepted", { amount: 50, password: "hunter2" });
// info: payment accepted {"amount":50,"password":"***"}
```

Маскировка смотрит на **имена полей**, а не на значения. Номер карты в поле
`card` или телефон в поле `contact` она не узнает:

```text
info: payment accepted {"card":"4111 1111 1111 1111"}
```

Персональные данные и номера карт в журнал не пишите — передавайте
идентификатор или последние цифры.

## Журнал запросов

`accessLog: true` в опциях `http` пишет строку на каждый запрос:

```text
info: GET /pay/50 200 6.9ms {"method":"GET","path":"/pay/50","status":200,"durationMs":6.9,"requestId":"req-7"}
```

Чтобы не засорять журнал проверками здоровья, пропускайте их:

```ts
http: { accessLog: { skip: (ctx) => ctx.path === "/health" } }
```

## Correlation id

`createCorrelationIdMiddleware()` даёт каждому запросу идентификатор:

```ts
import { createCorrelationIdMiddleware } from "bazis/core/http";

await runApp(AppModule, {
  http: { port: 3000, accessLog: true, middleware: [createCorrelationIdMiddleware()] },
});
```

- Если клиент прислал заголовок `x-request-id`, используется он. Иначе — и
  если присланное значение некорректно (пробелы, длина больше 128) —
  создаётся UUID.
- Идентификатор возвращается клиенту в заголовке ответа `x-request-id`.
- Он попадает в **каждую** строку журнала, записанную во время запроса:
  ваши сервисы, журнал запросов, ошибка `500`.
- Встроенный HTTP-клиент (`bazis/core/http-client`) передаёт его дальше в
  заголовке исходящих запросов — так запрос можно проследить через
  несколько сервисов. Заголовок W3C `traceparent` передаётся так же.

Пример: клиент прислал `x-request-id: req-7` — и все строки запроса
связаны:

```text
debug: checking limits {"amount":50,"requestId":"req-7"}
info: payment accepted {"amount":50,"requestId":"req-7"}
info: GET /pay/50 200 6.9ms {...,"requestId":"req-7"}
```

> [!NOTE]
> `requestId` в строках сервисов — с версии 0.97.11. Раньше он был только в
> журнале запросов и строках ошибок.

Сам идентификатор в коде — `getRequestId()` из `bazis/core/kernel`; вне
запроса он `undefined`.

## Что пишется само

| Событие | Строка |
| --- | --- |
| Запуск приложения (вне production) | `info: bazis started {...}` |
| Каждый запрос, если включён `accessLog` | `info: GET /pay/50 200 6.9ms {...}` |
| Неожиданная ошибка в запросе | `error: GET /pay/50 failed {...}` — см. [Обработку ошибок](../overview/errors.md#журнал-ошибок) |
| Падение фоновой службы | `error: background Worker crashed {...}` — см. [Жизненный цикл](lifecycle.md#падения-и-перезапуск) |
| Необработанная ошибка процесса | `error: Unhandled error, shutting down {...}` |

## Свой логгер

Чтобы писать журнал в другом формате — например, чистым JSON для системы
сбора журналов, — реализуйте интерфейс `Logger` и подключите его через
`useLogger`. Correlation id берите сами через `getRequestId()`:

```ts
import { getRequestId, type LogFields, type Logger } from "bazis/core/kernel";
import { redactSensitive } from "bazis/library/redaction";

export class JsonLogger implements Logger {
  debug(message: string, fields?: LogFields) { this.write("debug", message, fields); }
  info(message: string, fields?: LogFields) { this.write("info", message, fields); }
  warn(message: string, fields?: LogFields) { this.write("warn", message, fields); }
  error(message: string, fields?: LogFields) { this.write("error", message, fields); }

  private write(level: string, message: string, fields?: LogFields) {
    const line = { time: new Date().toISOString(), level, message, requestId: getRequestId(), ...redactSensitive(fields ?? {}) };
    console.log(JSON.stringify(line));
  }
}

await runApp(AppModule, { http: { port: 3000 }, configure: (kernel) => kernel.useLogger(new JsonLogger()) });
```

Не забудьте маскировку: стандартный логгер делает её сам, свой — нет.

## Дальше

- [Обработка ошибок](../overview/errors.md)
- [Middleware](../overview/middleware.md)
- Health checks *(в работе)*
