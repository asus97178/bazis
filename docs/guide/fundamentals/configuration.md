# Конфигурация

Настройки в bazis объявляются в коде — с типами, значениями по умолчанию и
проверками — а переопределяются переменными окружения. Приложение
проверяет все настройки при запуске: неверное значение или забытый
секрет останавливают его до открытия порта.

Короткое введение — в [Основах](../introduction/essentials.md#конфигурация-и-окружения).
Все примеры проверены на bazis 0.97.9.

## Объявление

```ts
// mail/Mail.config.ts
import { configEnum, defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface MailConfig {
  host: string;
  port: number;
  useTls: boolean;
  maxRetries: number;
  provider: "smtp" | "ses";
  apiKey: Secret;
}

export const mailConfig = defineConfig<MailConfig>("mail", {
  default: {
    host: "localhost",
    port: 1025,
    useTls: false,
    maxRetries: 3,
    provider: configEnum(["smtp", "ses"], "smtp"),
    apiKey: secret("dev-key"),
  },
  production: { useTls: true, apiKey: secret() },
  env: { host: "BAZIS_SMTP_HOST" },
  validate: {
    port: (port) => (port < 1 || port > 65535 ? "must be a TCP port (1-65535)" : undefined),
  },
});
```

| Часть | Что задаёт |
| --- | --- |
| `"mail"` | Префикс: ключи называются `mail.host`, `mail.port`… |
| `default` | Значения по умолчанию для всех окружений. Тип каждого ключа берётся отсюда |
| `development`, `test`, `production` | Что поменять в конкретном окружении |
| `env` | Дополнительные имена переменных окружения для ключа |
| `validate` | Свои проверки: вернуть строку — ошибка, `undefined` — порядок |

Значения бывают пяти видов:

| Вид | Как объявить | Из переменной окружения |
| --- | --- | --- |
| Строка | `host: "localhost"` | Как есть |
| Число | `port: 1025` | Должно быть числом: `2525` |
| Логическое | `useTls: false` | `true`, `false`, `1` или `0` |
| Перечисление | `configEnum(["smtp", "ses"], "smtp")` | Одно из перечисленных значений |
| Секрет | `secret("dev-key")` или `secret()` | Непустая строка |

Модуль подключает объявление полем `config`, сервис получает настройки по
типу:

```ts
@Module({ config: mailConfig, providers: [scoped(MailService)], exports: [MailService] })
export class MailModule {}

export class MailService {
  constructor(private readonly config: ConfigView<MailConfig>) {}

  send() {
    const host = this.config.get("host");          // string
    const port = this.config.get("port");          // number
    const key = this.config.get("apiKey").reveal(); // строка секрета
  }
}
```

Настройки, которые не принадлежат ни одному модулю, передают в
`runApp(AppModule, { config: [appConfig] })`.

## Откуда берутся значения

От слабого к сильному:

1. `default`;
2. секция текущего окружения (`production: { ... }`);
3. переменные окружения `BAZIS_*`, в том числе из файла `.env`;
4. аргументы командной строки: `bun src/index.ts --mail.port=2626`.

Проверено: при `BAZIS_MAIL__PORT=2525` и аргументе `--mail.port=2626`
приложение получает `2626`.

### Имена переменных окружения

Имя строится из префикса и ключа: `BAZIS_` + префикс + `__` + ключ, всё
заглавными:

| Ключ | Переменная |
| --- | --- |
| `mail.host` | `BAZIS_MAIL__HOST` |
| `mail.maxRetries` | `BAZIS_MAIL__MAXRETRIES` |
| `mail.apiKey` | `BAZIS_MAIL__APIKEY` |

Дополнительное имя задают в `env`: `env: { host: "BAZIS_SMTP_HOST" }`. Оно
тоже должно начинаться с `BAZIS_` — настройки читают только такие
переменные:

```text
Configuration key "mail.host": environment variable "SMTP_HOST" must start with BAZIS_:
configuration reads only BAZIS_* variables (for example BAZIS_SMTP_HOST).
```

Если заданы оба имени с разными значениями, запуск остановится:
`mail.host — conflicting environment aliases`.

Bun сам читает файл `.env` в корне проекта, так что переменные удобно
держать там. `bazis new` создаёт пример — `.env.example`.

### Свой источник: JSON-файл

Источники можно задать явно через `configure`. Например, добавить файл с
настройками — переменные окружения и аргументы останутся сильнее:

```ts
import { argsSource, envSource, jsonFileSource } from "bazis/core/kernel";

await runApp(AppModule, {
  http: { port: 3000 },
  configure: (kernel) => kernel
    .addConfigSource(jsonFileSource("config.json", { optional: true }))
    .addConfigSource(envSource())
    .addConfigSource(argsSource()),
});
```

```json
// config.json
{ "mail": { "port": 4545, "host": "smtp.internal" } }
```

Источники применяются по порядку: каждый следующий сильнее предыдущего.
Если задать `configure` с источниками, стандартные (`env` и аргументы) не
добавляются сами — перечислите их, как в примере.

## Проверка при запуске

Все ошибки собираются сразу, приложение не стартует:

```text
[bazis] configuration error: Invalid configuration (environment "development"):
mail.port — expected a finite number; mail.useTls — expected a boolean;
mail.provider — value is not one of the declared enum values.
```

Своя проверка из `validate`:

```text
Invalid configuration (environment "development"): mail.port — must be a TCP port (1-65535).
```

## Секреты

Пароли, ключи API, токены объявляйте через `secret()`:

- `config.get("apiKey")` возвращает объект `Secret`. Само значение —
  только через `.reveal()`.
- В журнале, в `JSON.stringify` и в ответах API секрет выглядит как `***`:
  `{"apiKeyAsJson":"***"}`.
- `secret()` без значения — обязательный секрет. Обычно так объявляют
  секцию `production`: в разработке работает `secret("dev-key")`, а в
  production без переменной приложение не запустится:

```text
mail.apiKey — required non-empty secret is not set (BAZIS_MAIL__APIKEY).
```

## Что получилось: `inspect()`

`ConfigView` умеет показать, откуда взялось каждое значение. Секреты при
этом скрыты:

```ts
this.config.inspect();
```

```json
[
  { "key": "mail.host", "type": "string", "env": ["BAZIS_MAIL__HOST", "BAZIS_SMTP_HOST"], "source": "default", "value": "localhost" },
  { "key": "mail.port", "type": "number", "env": ["BAZIS_MAIL__PORT"], "source": "env(BAZIS_*)", "value": 2525 },
  { "key": "mail.maxRetries", "type": "number", "env": ["BAZIS_MAIL__MAXRETRIES"], "source": "args", "value": 7 },
  { "key": "mail.apiKey", "type": "secret", "env": ["BAZIS_MAIL__APIKEY"], "source": "default", "value": "***" }
]
```

Удобно для отладки: видно, какая переменная сработала и какую можно было
задать.

## Настройки вне DI

Объявление можно прочитать и напрямую — например, в `src/index.ts` до
запуска:

```ts
mailConfig.get("port");
```

Но так видны только значения по умолчанию, секция окружения и переменные
`BAZIS_*`. Источники из `configure` и аргументы командной строки
собирает ядро при запуске — их видит только `ConfigView` внутри
приложения. Проверено: при `mail.port` из `config.json` равном `4545`
прямой `get` вернул `1025`, а сервис — `4545`. В сервисах всегда берите
`ConfigView`.

## Окружения

Окружение задаёт `BAZIS_ENV` (иначе `NODE_ENV`, иначе `production`):
`development`, `test` или `production`. От него зависят секция настроек и
поведение приложения — подробнее в главе
[Приложение](../overview/application.md#опции-kernel).

## Дальше

- [Приложение](../overview/application.md)
- [DI подробно](dependency-injection.md)
- Жизненный цикл *(в работе)*
