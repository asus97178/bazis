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
- ⏳ CORS, заголовки безопасности, журнал запросов
- ⏳ Ограничение частоты запросов
- ⏳ Кэширование ответов
- ⏳ HTTP-клиент

## 5. База данных (ORM)

- ⏳ Подключение PostgreSQL
- ⏳ Сущности и ключи — включая UUID v7
- ⏳ `DbContext` и `DbSet`
- ⏳ Запросы
- ⏳ Сохранение и отслеживание изменений
- ⏳ Транзакции
- ⏳ Немедленные изменения (update / delete без загрузки)
- ⏳ Управление схемой — `ensureCreated`, миграции
- ⏳ Репозитории
- ⏳ Owned stores
- ⏳ Динамические модели
- ⏳ Ошибки базы данных

## 6. Безопасность

- ⏳ Аутентификация через JWT
- ⏳ Шаблоны авторизации
- ⏳ Секреты и конфигурация
- ⏳ Чек-лист перед продакшеном

## 7. Реальное время и службы

- ⏳ WebSocket
- ⏳ gRPC
- ⏳ Фоновые службы
- ⏳ Кэширование

## 8. AI-агенты

- ⏳ Агенты, задачи, промпты
- ⏳ Инструменты (Tools)
- ⏳ Хуки инструментов и аудит
- ⏳ LLM-коннекторы
- ⏳ UI-профили

## 9. Инфраструктура

- ⏳ Обзор `@Infra`
- ⏳ PostgreSQL · Redis · OpenSearch · LLM · Codex
- ⏳ Свой коннектор

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
