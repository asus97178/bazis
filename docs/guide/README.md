# Руководство по bazis

> Черновик на русском. После вычитки руководство будет переведено на английский.

bazis — модульный бэкенд-фреймворк для [Bun](https://bun.com) на TypeScript.
Руководство идёт от простого к сложному: сначала один раз пройдите
«Введение», дальше читайте разделы по мере надобности.

Обозначения: ✅ — страница написана, ⏳ — в плане.

## 1. Введение

- ✅ [Что такое bazis](introduction/what-is-bazis.md)
- ✅ [Почему только Bun](introduction/why-bun.md)
- ✅ [Установка](introduction/installation.md)
- ✅ [Первые шаги](introduction/first-steps.md)
- ✅ [Основные понятия](introduction/essentials.md) — модуль, DI, контроллер, кодогенерация, конфигурация
- ⏳ Учебный проект: Todo API — по шагам на основе `examples/todo`

## 2. Обзор: строительные блоки

- ✅ [Модули](overview/modules.md) — `@Module`, `imports` / `exports`, корневой `AppModule`
- ✅ [Провайдеры и DI](overview/providers.md) — `scoped`, `singleton`, `transient`, внедрение через конструктор
- ✅ [Контроллеры](overview/controllers.md) — `@Controller`, `@Get` / `@Post`, параметры маршрута
- ✅ [Модели запросов и валидация](overview/validation.md) — `@RequestModel`, `@Validator`
- ✅ [Ответы](overview/responses.md) — `Ok`, `Created`, `NotFound`, файлы
- ✅ [Middleware](overview/middleware.md) — серверный и маршрутный уровни, порядок выполнения
- ✅ [Авторизация](overview/authorization.md) — `@Authorize`, `@AllowAnonymous`
- ✅ [Обработка ошибок](overview/errors.md) — `HttpError`, неожиданные ошибки, доменные ошибки
- ✅ [Приложение](overview/application.md) — `runApp`, запуск, остановка, коды выхода

## 3. Основы

- ✅ [Кодогенерация](fundamentals/codegen.md) — как связываются зависимости и HTTP, `src/generated`, цели
- ✅ [DI подробно](fundamentals/dependency-injection.md) — значения, фабрики, асинхронные фабрики, ключи, `Lazy`, освобождение ресурсов
- ✅ [Инкапсуляция модулей](fundamentals/encapsulation.md) — видимость, реэкспорт, одна реализация на токен, модули с параметрами
- ✅ [Архитектура модулей](fundamentals/module-architecture.md) — атомарные и составные модули, создание через CLI, паспорт `MODULE.md`
- ✅ [Конфигурация](fundamentals/configuration.md) — `defineConfig`, источники, переменные `BAZIS_*`, секреты, `inspect()`
- ✅ [Жизненный цикл](fundamentals/lifecycle.md) — фоновые службы, перезапуск, хуки, порядок запуска и остановки
- ✅ [События](fundamentals/events.md) — `EventBus`, `onEvent`, `@OnEvent`, порядок, ошибки
- ✅ [Логирование и correlation id](fundamentals/logging.md) — `Logger`, уровни, маскировка, журнал запросов, `x-request-id`
- ✅ [Health checks](fundamentals/health-checks.md) — `/health`, свои проверки, подробности, тайм-ауты
- ✅ [Тестирование](fundamentals/testing.md) — `bazis test`, `createTestContainer`, `startTestApp`, подмена зависимостей

## 4. HTTP

- ✅ [Маршрутизация и привязка параметров](http/routing.md) — выбор маршрута, параметры пути и строки запроса, массивы
- ✅ [Списки и JSON:API](http/lists.md) — `ListRequest`, `paginate`, сортировка, фильтры, страницы, выбор полей
- ✅ [Файлы и загрузка](http/files.md) — `formData`, пределы размера, `consumes`, отдача файлов
- ✅ [Версионирование API](http/versioning.md) — версия в пути, строке запроса или заголовке, общий код версий
- ✅ [OpenAPI](http/openapi.md) — документ из кода, коды ответов и ошибки, JSDoc
- ✅ [CORS, заголовки безопасности, журнал запросов](http/cors-headers-log.md) — источники и preflight, CORS для части маршрутов, HSTS и CSP, `accessLog`
- ✅ [Ограничение частоты запросов](http/rate-limit.md) — `rateLimit`, ключи, работа за прокси, заголовки `RateLimit-*`
- ✅ [Кэширование ответов](http/output-cache.md) — `@OutputCache`, ключи, сброс по тегам, защищённые маршруты, политики
- ✅ [HTTP-клиент](http/http-client.md) — `HttpClient`, повторы и тайм-ауты, ошибки и 502/504, именованные клиенты, браузер
- ⏳ Описание интерфейса (UI-профили) — отложено до выхода рендерера

## 5. База данных (ORM)

- ✅ [Подключение PostgreSQL](database/postgresql.md) — настройки, `@Infra`, ошибки подключения, TLS, пул и тайм-ауты
- ✅ [Сущности и ключи](database/entities.md) — таблицы, типы столбцов и NULL, ключи и UUID v7, индексы, `@Check`
- ✅ [`DbContext` и `DbSet`](database/dbcontext.md) — контекст модуля, время жизни, несколько модулей, методы `DbSet`, сырой SQL
- ✅ [Запросы](database/queries.md) — условия, поиск по тексту, порядок и страницы, `select`, `include`, отслеживание
- ✅ [Сохранение и отслеживание изменений](database/saving.md) — состояния, связанные сущности, объекты не из контекста, ошибки сохранения
- ✅ [Транзакции](database/transactions.md) — `transactionScope`, откат, блокировки строк и `skipLocked`, вложенные scope, `tx.use`, `afterCommit`, тайм-аут
- ✅ [Немедленные изменения](database/immediate.md) — `executeUpdate`, `executeDelete`, `insertIfAbsent`, мягкое удаление, ограничения и отслеживание
- ✅ [Управление схемой](database/schema.md) — `ensureCreated`, миграции и базовая точка, `migrateOnStart`, несколько модулей, имена ограничений
- ✅ [Репозитории](database/repositories.md) — `IRepository<T>`, общий контекст, экспорт в другой модуль, подмена в тестах
- ✅ [Owned stores](database/owned-stores.md) — таблицы, закреплённые за модулем: объявление, правила области, переход на новую версию
- ✅ [Динамические модели](database/dynamic-models.md) — таблицы, описанные данными: `buildDynamicModel`, `setByName`, связи, изменение на лету, реестр в DI
- ✅ [Ошибки базы данных](database/errors.md) — классы ошибок, обработка в коде, HTTP-статусы, тайм-ауты и недоступная база

## 6. Безопасность

- ✅ [Аутентификация через JWT](security/jwt.md) — пара токенов, обновление и отзыв refresh, HS256 и RS256, ротация ключей, виды токенов
- ✅ [Шаблоны авторизации](security/authorization-patterns.md) — текущий пользователь, роли и права, `anyOf`, владелец записи, арендаторы, ключи API
- ✅ [Секреты и конфигурация](security/secrets.md) — секрет в коде и production, файлы секретов, `.env` и бинарник, `Secret`, маскировка в логах, ротация
- ✅ [Чек-лист перед продакшеном](security/production-checklist.md) — что bazis делает сам, секреты, ошибки и `/health`, HTTP, открытые маршруты, пользователь БД без прав на схему, `BAZIS_SCHEMA_ONLY`

## 7. Реальное время и службы

- ✅ [WebSocket](realtime/websocket.md) — шлюзы в модуле, протокол и клиент, комнаты, отправка из сервиса через `WebSocketService`, вход по JWT, проверка данных и лимиты, переподключение
- ✅ [gRPC](realtime/grpc.md) — контракт `.proto`, контроллеры и четыре вида вызовов, проверка DTO, ошибки, `@Authorize`, срок вызова, клиент и `grpcClientProvider`, 502/504 в HTTP
- ✅ [Фоновые службы](realtime/background-services.md) — очередь задач в базе, несколько экземпляров: один раз за период и не одновременно, здоровье служб в `/health`
- ✅ [Кэширование](realtime/caching.md) — кэш в памяти и в Redis, `@Cacheable` и ключи, время жизни сервиса, только простые данные в Redis, недоступный Redis

## 8. AI-агенты

- ✅ [Агенты](ai/agents.md) — агент как данные, `AgentRuntime.run` и `check`, агенты в базе, что видит модель, структурированный ответ, аудит и подтверждение, диалог, пределы, тесты со скриптовой моделью
- ✅ [Инструменты](ai/tools.md) — `@Tool` и `@Module.tools`, схема для модели, проверка аргументов, контекст вызова, `ToolError` и журнал, срок и отмена, запись с неизвестным исходом, `AgentToolPreCommitError`, повторы
- ✅ [Хуки инструментов и аудит](ai/hooks.md) — `enforcement`, `settlement`, `observer`, причина отказа для модели, журнал вызовов и маскировка, отказ журнала, обязательные хуки
- ✅ [LLM-коннекторы](ai/llm-connectors.md) — конфигурация `llm`, `llmConnect` и `openAiCompatibleAdapter`, что уходит провайдеру, здоровье, профили `llmRouter`, запасная модель, ошибки, свой адаптер

## 9. Инфраструктура

- ✅ [Обзор `@Infra`](infra/overview.md) — манифест, клиенты по типу, порядок старта и остановки, сбой подключения, срок старта, здоровье, два экземпляра одного типа
- ✅ [Коннекторы](infra/connectors.md) — PostgreSQL (`postgres`), Redis, OpenSearch, Codex; LLM — в [отдельной главе](ai/llm-connectors.md)
- ✅ [Свой коннектор](infra/custom-connector.md) — клиент, тип для внедрения, `InfraConnector`, конфигурация и секреты, сервис поверх клиента

## 10. CLI

- ⏳ Обзор · `new` · `generate module` · `generate pack` · `codegen` · `dev` / `test` · `build`

## 11. Развёртывание

- ⏳ Один исполняемый файл
- ⏳ Настройка продакшена
- ⏳ Docker
- ⏳ Плавная остановка и health
- ⏳ Платформы

## 12. Рецепты

- ⏳ CRUD-модуль целиком
- ⏳ JWT и защита маршрутов
- ⏳ Несколько экземпляров приложения с Redis
- ⏳ Фоновая задача с базой данных
- ⏳ Инструмент агента, вызывающий сервис
- ⏳ Русская локализация
- ⏳ Если вы пришли с NestJS
- ⏳ Если вы пришли с ASP.NET Core

## 13. Справочник

- ⏳ API по точкам входа `bazis/...`
- ⏳ Команды CLI
- ⏳ Параметры конфигурации
- ⏳ Справочник ошибок — по странице на каждый код
- ⏳ Глоссарий · Версии и выпуски · Обновление между версиями
