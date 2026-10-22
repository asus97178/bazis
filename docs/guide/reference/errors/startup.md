# Ошибки запуска и конфигурации

Ошибки, которые останавливают приложение при старте или мешают ему
остановиться: настройки, подключения инфраструктуры, сроки запуска и
остановки. Классы — из `bazis/core/kernel` и `bazis/core/infra`.

Ошибку запуска приложение печатает одной строкой и выходит с кодом 1:
- `[bazis] configuration error:` — ошибка настроек или графа сервисов, её
  исправляют в коде или в переменных окружения;
- `[bazis] application failed:` — не удалось запустить то, что от кода не
  зависит: база, Redis, внешний сервис.

В терминале вместо строки печатается
[экран запуска](../../cli/commands.md#экран-запуска).

Тексты получены на bazis 0.100.8, кроме отмеченных.

## Настройки

### `ConfigValidationError`

Все неверные ключи всех настроек сразу, через `;`:

```text
[bazis] configuration error: Invalid configuration (environment "development"): mail.port — expected a finite number, got "abc" (BAZIS_MAIL__PORT); mail.useTls — expected a boolean (true, false, 1, 0), got "yes" (BAZIS_MAIL__USETLS); mail.provider — "sendgrid" is not allowed, use one of: smtp, ses (BAZIS_MAIL__PROVIDER).
```

В поле `issues` — каждое нарушение отдельно: ключ, вид, переменные
окружения, файл с `defineConfig`. Виды:

| Вид | Текст | Что сделать |
| --- | --- | --- |
| `number` | `expected a finite number, got "abc" (BAZIS_MAIL__PORT)` | Число в переменной |
| `boolean` | `expected a boolean (true, false, 1, 0), got "yes" (BAZIS_MAIL__USETLS)` | Одно из четырёх значений |
| `enum` | `"sendgrid" is not allowed, use one of: smtp, ses (BAZIS_MAIL__PROVIDER)` | Значение из списка `configEnum` |
| `validator` | `must be a TCP port (1-65535)` — текст вашей проверки из `validate` | Поправить значение |
| `missing-secret` | `required non-empty secret is not set (BAZIS_MAIL__APIKEY)` | Задать секрет переменной или [файлом секрета](../../security/secrets.md#файлы-секретов) |
| `development-secret` | `production would use the development default secret from the code; set BAZIS_MAIL__WEBHOOKTOKEN, or declare webhookToken in the production section` | Задать секрет для production; значение из кода в production не годится |
| `conflict` | `conflicting environment aliases: BAZIS_MAIL__HOST and BAZIS_SMTP_HOST are set to different values; set only one` | Основная переменная и имя из `env` заданы по-разному — оставить одну. Значения в тексте не показываются |
| `string` | `expected a string` | Текст из исходников: значение из своего источника настроек — не строка |

- Значения секретов в тексте не показываются: вместо них — `the value` или
  `***`.
- `missing-secret` — секрет без значения (`secret()`) в выбранном
  окружении; `development-secret` — только в `production`: так
  приложение не уедет на сервер с ключом из кода
  ([Секреты](../../security/secrets.md)).

### `KernelError` — имя переменной

```text
[bazis] configuration error: Configuration key "sms.host": environment variable "SMS_HOST" must start with BAZIS_: configuration reads only BAZIS_* variables (for example BAZIS_SMS_HOST).
```

- **Когда.** При запуске, вместе с проверкой настроек. Файл с
  `defineConfig` импортируется без ошибки; до версии 0.113.0 она
  случалась уже при импорте и печаталась со стеком Bun.
- Так же — ключ в разделе окружения, которого нет в `default`
  (`Unknown configuration key: sms.port.`), и неверный `configEnum`.
- **Что сделать.** Имена в `env` начинаются с `BAZIS_`.

### `ConfigKeyMissingError`

```text
Required configuration key "mail.region" is missing.
```

Текст из исходников. Код просит у `Configuration` ключ, которого нет ни в
одном `defineConfig`. Через `ConfigView<T>` такого не бывает — ключи
проверяет TypeScript.

## Подключения

### `InfraError`

Коннектор из `@Infra` не подключился. Текст называет коннектор, адрес и
причину:

```text
[bazis] application failed: InfraError: Infra connector "database": cannot connect to PostgreSQL at 127.0.0.1:1 (database "planner_test", user "postgres"): Failed to connect (ERR_POSTGRES_CONNECTION_REFUSED)
```

```text
InfraError: Infra connector "redis": failed to connect to redis://127.0.0.1:6379 within 5000 ms.
InfraError: Infra connector "llm": https://api.openai.com/v1 is not available — OpenAI-compatible GET /models failed with HTTP 401.
```

- **Что сделать.** Проверьте, что сервис запущен и доступен по адресу из
  текста; адрес и пароль — в настройках коннектора
  ([Инфраструктура](../../infra/overview.md)).
- Ключ LLM-провайдера проверяется при запуске вне среды `test`
  ([LLM-коннекторы](../../ai/llm-connectors.md#проверка-при-старте)).

### `StartupFailuresError`

Несколько подключений, которые стартуют одновременно, не поднялись.
Каждое — отдельной строкой:

```text
[bazis] application failed: StartupFailuresError: 2 services failed to start: infra:cache, infra:llm.
  - InfraError: Infra connector "redis": failed to connect to redis://127.0.0.1:6379 within 5000 ms.
  - InfraError: Infra connector "llm": https://api.openai.com/v1 is not available — OpenAI-compatible GET /models failed with HTTP 401.
```

Проверено на 0.100.6. Подключения одной фазы стартуют параллельно, поэтому
видны все сразу. База обычно стартует раньше остальных: если она
недоступна, приложение остановится на ней одной.

## Сроки

### `StartupTimeoutError`

```text
[bazis] application failed: StartupTimeoutError: Application startup did not finish within 1000ms; still starting: hook SlowWarmUp.onInit.
[bazis] Cleanup after the failed start did not finish within 10000ms. Forcing exit.
```

Запуск не уложился в `kernel.startupTimeoutMs` (по умолчанию 30 секунд).
В конце — что ещё запускалось: служба (`infra:search`) или хук
(`hook SlowWarmUp.onInit`).

Вторая строка — если зависшая работа не закончилась и за срок остановки
(`shutdownTimeoutMs`): приложение ждёт её, чтобы не закрыть подключения
из-под неё, и выходит принудительно.

> [!NOTE]
> До 0.100.8 при зависшем `onInit` печаталась только вторая строка, и
> причину было не узнать.

### `ShutdownTimeoutError`

```text
[bazis] Graceful shutdown did not finish within 1000ms. Forcing exit.
```

- **Причина.** Остановка не уложилась в `kernel.shutdownTimeoutMs` (по
  умолчанию 10 секунд): хук `onShutdown`, фоновая служба или запрос не
  завершились. Приложение выходит с кодом 1.
- **Что сделать.** Хуки и службы должны слушать сигнал отмены и
  заканчиваться в срок. Если работа долгая по природе — увеличьте срок и
  `stop_grace_period` у Docker
  ([Плавная остановка](../../deployment/graceful-shutdown.md#срок-остановки)).

### `StartupAbortedError`

```text
[bazis] application failed: StartupAbortedError: Application startup was aborted by a shutdown request.
```

Пришёл `SIGTERM` или `SIGINT`, пока приложение
запускалось. Обычно это нормально: оркестратор передумал. Про зависший
`onInit` — предупреждение у [`StartupTimeoutError`](#startuptimeouterror).

### `EventHandlerTimeoutError`

```text
Event "order.paid" handler exceeded 5000ms.
```

Текст из исходников. Обработчик события работал дольше
`handlerTimeoutMs` из параметров `publish`
([События](../../fundamentals/events.md)).

## Прочие ошибки ядра

`KernelError` — ошибка настройки самого приложения. Примеры:

```text
runApp: language "de" is not supported. Use one of: en, ru.
runApp: websocket options are set, but no module declares gateways. Add gateways: [ChatGateway] to the module that owns the gateway.
```

Текст подсказывает, что поменять в `runApp` или в модуле.

## Дальше

- [Ошибки DI](di.md)
- [Конфигурация](../../fundamentals/configuration.md)
- [Жизненный цикл](../../fundamentals/lifecycle.md)
