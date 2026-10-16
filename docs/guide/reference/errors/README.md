# Справочник ошибок

Каждая ошибка bazis — с текстом, причиной и тем, что сделать. Ищите по
началу сообщения или по коду.

## Где искать

| Что видно | Страница |
| --- | --- |
| Рамка `✖ … code BAZIS_…` от `bazis codegen`, `dev`, `test`, `build` | [Кодогенерация](codegen.md) |
| `[bazis] configuration error: Service graph validation failed:` / `Module encapsulation violated:` | [DI](di.md) |
| `[bazis] configuration error: Invalid configuration (environment "…")` | [Запуск и конфигурация](startup.md#configvalidationerror) |
| `[bazis] application failed: InfraError: Infra connector "…"` | [Запуск и конфигурация](startup.md#infraerror) |
| `[bazis] Graceful shutdown did not finish within …` | [Запуск и конфигурация](startup.md#shutdowntimeouterror) |
| `[bazis] application failed: HttpSetupError:` | [HTTP](http.md#httpsetuperror) |
| Ответ `{"error": "…"}` со статусом 4xx/5xx | [HTTP](http.md#ответы-клиенту) |
| `HttpClientError` с `code` `ETIMEDOUT`, `ERR_BAD_STATUS`… | [HTTP](http.md#http-клиент) |
| `UniqueViolationError`, `SchemaAdmissionError [ORM_SCHEMA_…]`, `ORM_OWNED_STORE_…` | [ORM](orm.md) |
| `result.error.code` агента `AGENT_…`, инструмента `TOOL_…`, `CodexError` | [Агенты](agents.md) |
| `CacheUnavailableError`, `CacheValueError`… | [Кэш](cache.md) |
| Пакет WebSocket `error`, `WebSocketDeliveryError`, `GrpcError` | [WebSocket и gRPC](realtime.md) |
| `JwtExpiredError`, `JwtSignatureError`… | [JWT](jwt.md) |

## Как bazis сообщает об ошибках

- **До запуска** — кодогенерация. Ошибка в рамке с местом в коде и
  кодом `BAZIS_…`; команда выходит с кодом 1.
- **При запуске** — одна строка, приложение выходит с кодом 1:
  - `[bazis] configuration error:` — ошибка настроек или графа сервисов,
    её исправляют в коде или в переменных окружения;
  - `[bazis] application failed:` — не поднялось то, что от кода не
    зависит: база, Redis, внешний сервис. Сюда же пока попадают
    ошибки маршрутов.

  В терминале вместо строки — [экран запуска](../../cli/commands.md#экран-запуска)
  со всеми ошибками сразу.
- **Во время работы** — ответ клиенту и строка в журнале. Клиенту — без
  подробностей; в журнал — с классом, текстом и стеком, секреты
  замаскированы.
- **У агентов** — код в результате запуска, а не исключение.

Классы ошибок экспортируются точками входа: `DiError` — из
`bazis/core/di`, `HttpError` — из `bazis/core/http` и т. д. Проверяйте
класс через `instanceof` и поле `code`, а не текст: тексты уточняются
от версии к версии, классы и коды меняются реже и с записью в CHANGELOG.

## Страницы

- [Кодогенерация](codegen.md) — коды `BAZIS_*`
- [DI](di.md) — граф сервисов, модули, области
- [Запуск и конфигурация](startup.md) — настройки, подключения, сроки
- [HTTP](http.md) — ответы, маршруты, HTTP-клиент
- [ORM](orm.md) — ограничения, транзакции, схема
- [Агенты](agents.md) — коды `AGENT_*`, `TOOL_*`, Codex
- [Кэш](cache.md)
- [WebSocket и gRPC](realtime.md)
- [JWT](jwt.md)
