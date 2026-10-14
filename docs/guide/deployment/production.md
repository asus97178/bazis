# Настройка продакшена

Что задать приложению для production: точка входа, переменные
окружения сервера, журнал, сроки, проверка перед выкладкой. Что именно
проверить по безопасности — в [чек-листе](../security/production-checklist.md);
здесь — как это собрать вместе.

Все примеры проверены на bazis 0.100.2 и PostgreSQL 17.

## Точка входа

Шаблон `bazis new` рассчитан на разработку. Для production в нём стоит
включить журнал запросов, HSTS, статусы ошибок базы данных, строку о
старте и файлы секретов:

```ts
// src/index.ts
import { runApp } from "bazis/core/app";
import { argsSource, envSource, secretFilesSource } from "bazis/core/kernel";
import { databaseErrorStatus } from "bazis/core/orm";
import { AppModule } from "./app/modules/App.module";
import { AppInfra } from "./app/infra/App.infra";
import { registerBazisGeneratedRuntime } from "./generated/bazis/runtime";

await registerBazisGeneratedRuntime();
await runApp(AppModule, {
  infra: AppInfra,
  http: {
    hostname: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000),
    health: true,                                  // /health для оркестратора
    accessLog: true,                               // строка на каждый запрос
    securityHeaders: { hsts: true },               // TLS — на прокси перед приложением
    errorHandler: { status: databaseErrorStatus }, // 409/422/404/503 вместо 500
  },
  kernel: { startupReport: true },                 // строка о старте и в production
  configure: (kernel) => kernel
    .addConfigSource(secretFilesSource(process.env.SECRETS_DIR ?? "/run/secrets", { optional: true }))
    .addConfigSource(envSource())
    .addConfigSource(argsSource()),
});
```

| Что | Зачем | Подробнее |
| --- | --- | --- |
| `hostname`, `port` из `HOST`, `PORT` | Один файл для всех стендов | [ниже](#адрес-и-порт) |
| `health: true` | Оркестратор знает, что приложение готово | [Плавная остановка и health](graceful-shutdown.md) |
| `accessLog: true` | Запросы видны в журнале | [Журнал запросов](../fundamentals/logging.md#журнал-запросов) |
| `securityHeaders: { hsts: true }` | Браузер ходит только по HTTPS | [Чек-лист](../security/production-checklist.md#http) |
| `errorHandler.status` | Нарушение уникальности — `409`, а не `500` | [Ошибки базы данных](../database/errors.md#http-статусы) |
| `startupReport: true` | В журнале видно, что приложение запустилось | [ниже](#журнал) |
| `secretFilesSource` | Секреты Docker и Kubernetes из файлов | [Файлы секретов](../security/secrets.md#файлы-секретов) |

## Переменные окружения

Всё, что отличается между стендами, — в переменных окружения. Для
приложения из примера:

| Переменная | Пример | Что задаёт |
| --- | --- | --- |
| `BAZIS_ENV` | `production` | Среда; без неё — тоже production, но лучше явно |
| `HOST` | `0.0.0.0` | На каком адресе слушать |
| `PORT` | `8080` | Порт |
| `BAZIS_DB__HOST`, `BAZIS_DB__PORT`, `BAZIS_DB__DATABASE`, `BAZIS_DB__USERNAME` | `db.internal` … | Подключение к базе |
| `BAZIS_DB__PASSWORD` | — | Секрет: переменная или файл `/run/secrets/BAZIS_DB__PASSWORD` |
| `SECRETS_DIR` | `/run/secrets` | Каталог файлов секретов, если не стандартный |

Имена `BAZIS_…` строятся из ключей конфигурации: `db.password` →
`BAZIS_DB__PASSWORD` ([Конфигурация](../fundamentals/configuration.md#имена-переменных-окружения)).
Неверное или пропущенное значение останавливает запуск с кодом 1 и
названием переменной — до того, как приложение начнёт принимать запросы.

### Адрес и порт

Шаблон слушает `127.0.0.1` — только локальные подключения. В контейнере
и за балансировщиком нужен `HOST=0.0.0.0`, иначе запросы снаружи не
дойдут. Сам сервер работает по HTTP; TLS завершается на прокси или
балансировщике.

## Журнал

Журнал пишется в stdout и stderr по строке на событие: уровень, текст и
поля в JSON. Его собирает то, что запускает приложение: journald, Docker,
Kubernetes. С точкой входа выше:

```text
info: bazis started {"environment":"production","debug":false,"configKeys":2,"configMs":3.5,"containerMs":23.6,"hostedServices":3,"hooks":0,"startupMs":214.9}
info: POST /orders 201 9.3ms {"method":"POST","path":"/orders","status":201,"durationMs":9.34}
info: POST /orders 409 5.0ms {"method":"POST","path":"/orders","status":409,"durationMs":4.95}
```

- В production пишутся уровни `info` и выше; `debug` — только вне
  production.
- Пароли, токены и учётные данные в адресах маскируются.
- Без `startupReport: true` успешный старт в production не пишет ничего.

Свой формат или отправка в систему сбора — через свой логгер
([Свой логгер](../fundamentals/logging.md#свой-логгер)).

## Сроки

| Что | По умолчанию | Где задать |
| --- | --- | --- |
| Запуск целиком | 30 с | `kernel: { startupTimeoutMs }` |
| Остановка целиком | 10 с | `kernel: { shutdownTimeoutMs }` |
| Простой соединения клиента | 10 с (Bun) | `http: { idleTimeoutSeconds }` |
| Очистка зависимостей запроса | 5 с | `http: { requestScopeDisposeTimeoutMs }` |
| Проверка `/health` | 5 с | `http: { health: { timeoutMs } }` |
| Подключение к Redis | 5 с | `redisConnect(…, { connectTimeoutMs })` |
| Пул соединений PostgreSQL | 10 соединений | ключ `max` в конфигурации базы |

Срок остановки должен быть меньше, чем оркестратор ждёт после `SIGTERM`
(в Kubernetes по умолчанию 30 секунд), — иначе процесс убьют посреди
остановки.

## Перед выкладкой

1. Соберите файл и примените схему отдельным шагом —
   `BAZIS_SCHEMA_ONLY=1` ([Шаг схемы](single-executable.md#шаг-схемы)).
2. Запустите новую версию на стенде с настройками production. Ошибки
   конфигурации и подключений приложение покажет сразу при старте и выйдет
   с кодом 1.
3. Дождитесь `200` от `/health` и только потом переключайте трафик.
4. Пройдите [чек-лист](../security/production-checklist.md).

## Дальше

- [Один исполняемый файл](single-executable.md)
- [Docker](docker.md)
- [Плавная остановка и health](graceful-shutdown.md)
- [Секреты и конфигурация](../security/secrets.md)
