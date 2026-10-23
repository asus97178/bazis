# API по точкам входа

Пакет `bazis` открывает API только через точки входа `bazis/...`; всё, что
не экспортировано из них, — внутреннее. На каждой странице — все экспорты
точки входа по группам, с главой руководства, где о них подробно.

Списки — по пакету 0.115.1.

## Приложение

| Точка входа | Что в ней |
| --- | --- |
| [`bazis/core/app`](core-app.md) | `runApp` |
| [`bazis/core/di`](core-di.md) | Модули, регистрации, токены, контейнер |
| [`bazis/core/kernel`](core-kernel.md) | Настройки и секреты, жизненный цикл, журнал, события, здоровье |
| [`bazis/core/http`](core-http.md) | Контроллеры, аргументы, ответы, ошибки, middleware, авторизация, списки |
| [`bazis/core/testing`](core-testing.md) | `startTestApp`, `createTestContainer` |

## Данные и инфраструктура

| Точка входа | Что в ней |
| --- | --- |
| [`bazis/core/orm`](core-orm.md) | ORM: сущности, контекст, запросы, транзакции, схема, репозитории |
| [`bazis/core/infra`](core-infra.md) | `@Infra` и коннекторы: PostgreSQL, Redis, OpenSearch, LLM, Codex |
| [`bazis/core/cache`](core-cache.md) | Кэш в памяти и в Redis, кэш методов и ответов |
| [`bazis/core/http-client`](core-http-client.md) | HTTP-клиент для внешних сервисов |

## Реальное время и AI

| Точка входа | Что в ней |
| --- | --- |
| [`bazis/core/background`](core-background.md) | Фоновые службы |
| [`bazis/core/websocket`](core-websocket.md) | WebSocket: шлюзы, комнаты, адаптеры |
| [`bazis/core/grpc`](core-grpc.md) | gRPC: сервер и клиент |
| [`bazis/core/agent`](core-agent.md) | Агенты и инструменты |

## Библиотеки

Работают и без приложения.

| Точка входа | Что в ней |
| --- | --- |
| [`bazis/library/validation`](library-validation.md) | `@Validator` и тексты ошибок проверки |
| [`bazis/library/jwt`](library-jwt.md) | JWT: пары токенов, ключи, ротация |
| [`bazis/library/jsonapi`](library-jsonapi.md) | Списки JSON:API |
| [`bazis/library/openapi`](library-openapi.md) | Документ OpenAPI и `/docs` |
| [`bazis/library/redaction`](library-redaction.md) | Маскировка секретов |
| [`bazis/library/terminal`](library-terminal.md) | Экраны CLI |
| [`bazis/library/orm`](library-orm.md) | ORM без DI — в приложении `bazis/core/orm` |
| [`bazis/library/http-client`](library-http-client.md) | HTTP-клиент без DI — в приложении `bazis/core/http-client` |
| [`bazis/library/boundary`](library-boundary.md) | Безопасная граница JSON, каноничный JSON, схемы |
| [`bazis/library/ui`](library-ui.md) | UI-профили — экспериментально |

## Служебные

[`bazis/core/generatedRuntime`, `bazis/core/http/OpenApi/generatedOpenApiRegistry`](generated.md) —
для сгенерированного кода.
