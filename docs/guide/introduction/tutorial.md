# Учебный проект: планировщик задач

Сквозной пример: от `bazis new` до одного исполняемого файла в
production. Приложение — планировщик: пользователи входят по JWT, ведут
свои задачи и проекты. Каждый шаг — отдельная страница; идите по порядку,
каждая продолжает код предыдущей.

Весь маршрут проверен на bazis 0.105.3 и PostgreSQL 17, второй модуль — на 0.106.0.

Нужны Bun 1.4.0 или новее ([Установка](installation.md)) и PostgreSQL.
Локальная база в Docker:

```sh
docker run -d --name planner-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
docker exec planner-pg psql -U postgres -c "CREATE DATABASE planner" -c "CREATE DATABASE planner_test"
```

`planner_test` — для тестов: они чистят таблицы перед каждым случаем.

## Шаги

| Шаг | Что появляется | Чему учит |
| --- | --- | --- |
| 1. [CRUD-модуль](../recipes/crud-module.md) | Проект, база, задачи: создание, список с фильтрами и страницами, действие «выполнить», тест | Модуль, сущность и `DbContext`, модели запроса и проверка, `ListRequest`, `startTestApp` |
| 2. [JWT и защита маршрутов](../recipes/jwt-auth.md) | Регистрация, вход, токены, первый администратор, «каждый видит свои задачи» | Настройки и секреты, `@Authorize`, scoped `CurrentUser`, служба при старте |
| 3. [Второй модуль](../recipes/projects-module.md) | Проекты, задача в проекте, очистка при удалении проекта | Контракт модуля и `exports`, зависимость между модулями, события |
| 4. [Сборка и запуск](#4-сборка-и-запуск) | Один исполняемый файл, запуск в production | `bazis build --bin`, обязательные секреты |

## Что получится

| Маршрут | Кто | Что делает |
| --- | --- | --- |
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` | Все | Регистрация, вход, новая пара токенов |
| `GET /auth/me` | Вошедшие | Кто я |
| `GET /auth/users` | Администратор | Все пользователи |
| `GET/POST /projects`, `DELETE /projects/:id` | Вошедшие | Свои проекты |
| `GET/POST /tasks`, `GET/PUT/DELETE /tasks/:id`, `POST /tasks/:id/complete` | Вошедшие | Свои задачи; администратор видит все |

```text
src/app/
├── config/db.config.ts
├── infra/App.infra.ts
├── test/testApp.ts
└── modules/
    ├── App.module.ts
    ├── auth/        пользователи, токены, проверка входа
    ├── tasks/       задачи
    └── projects/    проекты
```

## 4. Сборка и запуск

```sh
bunx bazis build --bin
```

```text
  [OK  ]  codegen         33 files · 12 deps · 3 controllers · 5 request models · 1 list  769 ms
  [OK  ]  typecheck       no type errors                                                   2.9 s
  [OK  ]  compile         bin/planner · 62.7 MB                                           199 ms
    ✔  SUCCESS   executable is ready · bin/planner
```

Исполняемый файл запускается в `production`. Секреты, у которых нет
значения для production, обязательны — без них приложение не стартует и
называет каждый:

```text
$ ./bin/planner
[bazis] configuration error: Invalid configuration (environment "production"): db.password — required non-empty
secret is not set (BAZIS_DB__PASSWORD); auth.jwtSecret — required non-empty secret is not set (BAZIS_AUTH__JWTSECRET);
auth.adminPassword — required non-empty secret is not set (BAZIS_AUTH__ADMINPASSWORD).
```

```sh
BAZIS_DB__PASSWORD=postgres \
BAZIS_AUTH__JWTSECRET="$(openssl rand -base64 32)" \
BAZIS_AUTH__ADMINPASSWORD="$(openssl rand -base64 18)" \
./bin/planner
```

```text
$ curl localhost:3000/health
{"healthy":true,"checks":[{"name":"infra:db","healthy":true,…},{"name":"background:AdminSeed","healthy":true,…}]}
```

В журнал пишутся строки запуска и остановки:

```text
info: bazis started {"environment":"production","debug":false,"configKeys":6,"configMs":0.2,"containerMs":2.2,"hostedServices":6,"hooks":0,"startupMs":127.8,"listening":["http://127.0.0.1:3096"]}
info: bazis stopped {"signal":"SIGTERM","exitCode":0,"shutdownMs":1.1}
```

Как выкладывать — в разделе «Развёртывание»:

- [Один исполняемый файл](../deployment/single-executable.md)
- [Настройка продакшена](../deployment/production.md) и [Docker](../deployment/docker.md)
- [Чек-лист перед продакшеном](../security/production-checklist.md)

## Дальше

- [Основные понятия](essentials.md) — если что-то в шагах было непонятно
- [Кэширование](../realtime/caching.md), [фоновые службы](../realtime/background-services.md), [WebSocket](../realtime/websocket.md) — что добавить в планировщик
