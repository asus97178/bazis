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

## 2. Приложение

То, что не принадлежит одному модулю: запуск, инфраструктура, общие настройки HTTP, вход.

- ✅ [Приложение](application/application.md) — `@App`, `runApp`, запуск, остановка, коды выхода
- ✅ [Жизненный цикл](application/lifecycle.md) — фоновые службы, перезапуск, хуки, порядок запуска и остановки
- ✅ [Плавная остановка и health](application/graceful-shutdown.md) — `SIGTERM`, срок остановки и коды выхода, `/health`, проверки Kubernetes
- ✅ [Кодогенерация](application/codegen.md) — как связываются зависимости и HTTP, `src/generated`, цели
- ✅ [Обзор `@Infra`](application/infra/overview.md) — манифест, клиенты по типу, порядок старта и остановки, сбой подключения, срок старта, здоровье, два экземпляра одного типа
- ✅ [Коннекторы](application/infra/connectors.md) — PostgreSQL (`postgres`), Redis, OpenSearch, Codex; LLM — в [отдельной главе](agents/llm-connectors.md)
- ✅ [Свой коннектор](application/infra/custom-connector.md) — клиент, тип для внедрения, `InfraConnector`, конфигурация и секреты, сервис поверх клиента
- ✅ [Кэширование](application/caching.md) — кэш в памяти и в Redis, `@Cacheable` и ключи, время жизни сервиса, только простые данные в Redis, недоступный Redis
- ✅ [CORS, заголовки безопасности, журнал запросов](application/cors-headers-log.md) — источники и preflight, CORS для части маршрутов, HSTS и CSP, `accessLog`
- ✅ [Ограничение частоты запросов](application/rate-limit.md) — `rateLimit`, ключи, работа за прокси, заголовки `RateLimit-*`
- ✅ [Логирование и correlation id](application/logging.md) — `Logger`, уровни, маскировка, журнал запросов, `x-request-id`
- ✅ [Health checks](application/health-checks.md) — `/health`, свои проверки, подробности, тайм-ауты
- ✅ [Аутентификация через JWT](application/jwt.md) — пара токенов, обновление и отзыв refresh, HS256 и RS256, ротация ключей, виды токенов
- ✅ [Шаблоны авторизации](application/authorization-patterns.md) — текущий пользователь, роли и права, `anyOf`, владелец записи, арендаторы, ключи API

## 3. Модуль

Всё, что можно положить в `@Module`: у каждого поля своя глава.

- ✅ [Модули](module/modules.md) — `@Module`, `imports` / `exports`, корневой `AppModule`
- ✅ [Инкапсуляция модулей](module/encapsulation.md) — видимость, реэкспорт, одна реализация на токен, модули с параметрами
- ✅ [Архитектура модулей](module/module-architecture.md) — атомарные и составные модули, создание через CLI, паспорт `MODULE.md`

### Сервисы (`providers`)

- ✅ [Провайдеры и DI](module/services/providers.md) — `scoped`, `singleton`, `transient`, внедрение через конструктор
- ✅ [DI подробно](module/services/dependency-injection.md) — значения, фабрики, асинхронные фабрики, ключи, `Lazy`, освобождение ресурсов
- ✅ [События](module/services/events.md) — `EventBus`, `onEvent`, `@OnEvent`, порядок, ошибки

### Настройки (`config`)

- ✅ [Конфигурация](module/config/configuration.md) — `defineConfig`, источники, переменные `BAZIS_*`, секреты, `inspect()`
- ✅ [Секреты и конфигурация](module/config/secrets.md) — секрет в коде и production, файлы секретов, `.env` и бинарник, `Secret`, маскировка в логах, ротация

### Контроллеры (`controllers`)

- ✅ [Контроллеры](module/controllers/controllers.md) — `@Controller`, `@Get` / `@Post`, параметры маршрута
- ✅ [Маршрутизация и привязка параметров](module/controllers/routing.md) — выбор маршрута, параметры пути и строки запроса, массивы
- ✅ [Модели запросов и валидация](module/controllers/validation.md) — `@RequestModel`, `@Validator`
- ✅ [Ответы](module/controllers/responses.md) — `Ok`, `Created`, `NotFound`, файлы
- ✅ [Обработка ошибок](module/controllers/errors.md) — `HttpError`, неожиданные ошибки, доменные ошибки
- ✅ [Middleware](module/controllers/middleware.md) — серверный и маршрутный уровни, порядок выполнения
- ✅ [Авторизация](module/controllers/authorization.md) — `@Authorize`, `@AllowAnonymous`
- ✅ [Списки и JSON:API](module/controllers/lists.md) — `ListRequest`, `paginate`, сортировка, фильтры, страницы, выбор полей
- ✅ [Файлы и загрузка](module/controllers/files.md) — `formData`, пределы размера, `consumes`, отдача файлов
- ✅ [Версионирование API](module/controllers/versioning.md) — версия в пути, строке запроса или заголовке, общий код версий
- ✅ [OpenAPI](module/controllers/openapi.md) — документ из кода, коды ответов и ошибки, JSDoc
- ✅ [Кэширование ответов](module/controllers/output-cache.md) — `@OutputCache`, ключи, сброс по тегам, защищённые маршруты, политики

### WebSocket (`gateways`)

- ✅ [WebSocket](module/websocket.md) — шлюзы в модуле, протокол и клиент, комнаты, отправка из сервиса через `WebSocketService`, вход по JWT, проверка данных и лимиты, переподключение

### gRPC (`grpcControllers`, `grpcClients`)

- ✅ [gRPC](module/grpc.md) — контракт `.proto`, контроллеры и четыре вида вызовов, проверка DTO, ошибки, `@Authorize`, срок вызова, клиент как класс с `@GrpcClient` и поле `grpcClients`, 502/504 в HTTP

### HTTP-клиенты (`httpClients`)

- ✅ [HTTP-клиент](module/http-client.md) — клиент как класс с `@HttpClient` и поле `httpClients`, повторы и тайм-ауты, ошибки и 502/504, несколько сервисов, браузер

### Фоновые службы (`background`)

- ✅ [Фоновые службы](module/background-services.md) — очередь задач в базе, несколько экземпляров: один раз за период и не одновременно, здоровье служб в `/health`

### База данных (`ormBazis`)

- ✅ [Подключение PostgreSQL](module/database/postgresql.md) — настройки, `@Infra`, ошибки подключения, TLS, пул и тайм-ауты
- ✅ [Сущности и ключи](module/database/entities.md) — таблицы, типы столбцов и NULL, ключи и UUID v7, индексы, `@Check`
- ✅ [`DbContext` и `DbSet`](module/database/dbcontext.md) — контекст модуля, время жизни, несколько модулей, методы `DbSet`, сырой SQL
- ✅ [Запросы](module/database/queries.md) — условия, поиск по тексту, порядок и страницы, `select`, `include`, отслеживание
- ✅ [Сохранение и отслеживание изменений](module/database/saving.md) — состояния, связанные сущности, объекты не из контекста, ошибки сохранения
- ✅ [Транзакции](module/database/transactions.md) — `transactionScope`, откат, блокировки строк и `skipLocked`, вложенные scope, `tx.use`, `afterCommit`, тайм-аут
- ✅ [Фильтры запросов и мягкое удаление](module/database/filters.md) — `@SoftDelete`, корзина и восстановление, связи, уникальные индексы, `@QueryFilter`, `ignoreQueryFilters`
- ✅ [Немедленные изменения](module/database/immediate.md) — `executeUpdate`, `executeDelete`, `insertIfAbsent`, мягкое удаление, ограничения и отслеживание
- ✅ [Управление схемой](module/database/schema.md) — `ensureCreated`, миграции и базовая точка, `migrateOnStart`, несколько модулей, имена ограничений
- ✅ [Репозитории](module/database/repositories.md) — `IRepository<T>`, общий контекст, экспорт в другой модуль, подмена в тестах
- ✅ [Owned stores](module/database/owned-stores.md) — таблицы, закреплённые за модулем: объявление, правила области, переход на новую версию
- ✅ [Динамические модели](module/database/dynamic-models.md) — таблицы, описанные данными: `buildDynamicModel`, `setByName`, связи, изменение на лету, реестр в DI
- ✅ [Ошибки базы данных](module/database/errors.md) — классы ошибок, обработка в коде, HTTP-статусы, тайм-ауты и недоступная база

### Права и роли (`permissions`, `roles`, `references`)

- ✅ [Права модулей](module/access.md) — `definePermissions`, `can`, фильтр списков по правам, роли по умолчанию, своя система прав (`AccessPolicy`), каталог для админки

### Инструменты (`tools`, `agentToolHooks`)

Операции модуля с контрактом. Их вызывают и бизнес-процессы, и агенты.

- ✅ [Инструменты](module/tools/tools.md) — `@Tool` и `@Module.tools`, схема для модели, проверка аргументов, контекст вызова, `ToolError` и журнал, срок и отмена, запись с неизвестным исходом, `AgentToolPreCommitError`, повторы
- ✅ [Хуки инструментов и аудит](module/tools/hooks.md) — `enforcement`, `settlement`, `observer`, причина отказа для модели, журнал вызовов и маскировка, отказ журнала, обязательные хуки

### Бизнес-процессы (`processes`)

- ✅ [Бизнес-процессы](module/processes.md) — `WorkflowModule`, документ процесса, публикация версий, запуск, ошибка шага и повтор, задача сотруднику и входящие задачи, повторы, ошибки с причиной и таймеры, события, расписание, отмена, права `workflow.*`, несколько экземпляров

### Генерируемый UI (`uiProfiles`)

- ⏳ Описание интерфейса (UI-профили) — отложено до выхода рендерера

## 4. AI-агенты

- ✅ [Агенты](agents/agents.md) — агент как данные, `AgentRuntime.run` и `check`, агенты в базе, что видит модель, структурированный ответ, аудит и подтверждение, диалог, пределы, тесты со скриптовой моделью
- ✅ [LLM-коннекторы](agents/llm-connectors.md) — конфигурация `llm`, `llmConnect` и `openAiCompatibleAdapter`, что уходит провайдеру, здоровье, профили `llmRouter`, запасная модель, ошибки, свой адаптер

## 5. Тестирование

- ✅ [Тестирование](testing/testing.md) — `bazis test`, `createTestContainer`, `startTestApp`, подмена зависимостей

## 6. CLI

- ✅ [Команды CLI](cli/commands.md) — вывод и язык, `new`, `g module`, `g pack`, `codegen`, `dev` и экран запуска, `test`, `build` и исполняемый файл, коды выхода, переменные окружения

## 7. Развёртывание

- ✅ [Один исполняемый файл](deployment/single-executable.md) — сборка, что попадает внутрь, запуск, среда production, шаг схемы
- ✅ [Настройка продакшена](deployment/production.md) — точка входа для production, переменные окружения, журнал, сроки, порядок выкладки
- ✅ [Docker](deployment/docker.md) — двухэтапный образ, healthcheck без curl, секреты, Compose с шагом схемы
- ✅ [Платформы](deployment/platforms.md) — glibc и musl, Linux-файл с Mac (`--platform`), systemd
- ✅ [Чек-лист перед продакшеном](deployment/production-checklist.md) — что bazis делает сам, секреты, ошибки и `/health`, HTTP, открытые маршруты, пользователь БД без прав на схему, `BAZIS_SCHEMA_ONLY`

## 8. Рецепты и справочник

### Рецепты

- ✅ [CRUD-модуль целиком](recipes/crud-module.md)
- ✅ [JWT и защита маршрутов](recipes/jwt-auth.md)
- ✅ [Второй модуль и связь между модулями](recipes/projects-module.md)
- ✅ [Несколько экземпляров приложения с Redis](recipes/multiple-instances.md)
- ✅ [Фоновая задача с базой данных](recipes/background-job.md)
- ✅ [Инструмент агента, вызывающий сервис](recipes/agent-tool.md)
- ✅ [Русская локализация](recipes/russian.md)
- ✅ [Если вы пришли с NestJS](recipes/from-nestjs.md)
- ✅ [Если вы пришли с ASP.NET Core](recipes/from-aspnet-core.md)

### Справочник

- ✅ [API по точкам входа `bazis/...`](reference/api/README.md)
- ✅ [Команды CLI](cli/commands.md)
- ✅ [Параметры конфигурации](reference/configuration.md)
- ✅ [Справочник ошибок](reference/errors/README.md)
- ✅ [Глоссарий](reference/glossary.md) · [Версии и выпуски](reference/versions.md) · [Обновление между версиями](reference/upgrading.md)
