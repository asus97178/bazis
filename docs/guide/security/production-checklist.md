# Чек-лист перед продакшеном

Что проверить перед первым выпуском и перед каждым крупным обновлением.
Подробности — в главах по ссылкам; здесь — что сделать и как убедиться,
что сделано.

Все пункты проверены на bazis 0.109.1 и PostgreSQL 17.

## Что bazis уже делает сам

Это не нужно настраивать — достаточно не выключать:

| Что | Как ведёт себя в production |
| --- | --- |
| Окружение | Без `BAZIS_ENV` и `NODE_ENV` приложение считает себя production |
| Ответ на ошибку | `500 {"error":"Internal Server Error"}` — без текста и стека |
| Документация API | `/docs` выключена |
| Заголовки безопасности | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` — на всех ответах, в том числе `404` и `405` |
| Размер тела запроса | Больше 1 МиБ — `413` |
| Лишние поля в теле | Отбрасываются: `{"text":"hi","ownerId":"…","isAdmin":true}` доходит до метода как `{"text":"hi"}` |
| `__proto__`, `constructor` в JSON | Отбрасываются, прототипы не меняются |
| Неверные типы и глубокая вложенность | `400` с описанием ошибки |
| `x-request-id` от клиента | Принимается, только если это до 128 безопасных символов |
| Секреты | Без значения не запускается; секрет из кода в production — тоже ([Секреты](secrets.md)) |
| Журнал | Маскирует пароли, токены и учётные данные в адресах |

## Окружение и секреты

- [ ] **Стенды, доступные снаружи, работают как `production`.** Staging и
  демо — тоже: в `development` ответ на ошибку содержит текст и стек.
- [ ] **Ни один секрет не берётся из кода.** Приложение само откажется
  стартовать, если production получит секрет из `default`. Откуда пришло
  каждое значение, покажет `inspect()`: у секретов `source` должен быть
  `env(BAZIS_*)` или `files(…)`, а не `default`.
- [ ] **Секреты — в переменных окружения или файлах секретов**, не в
  аргументах командной строки и не в репозитории
  ([Где хранить секреты](secrets.md#где-хранить-секреты-в-production)).
- [ ] **`.env` и `.env.*` не в git**, кроме `.env.example`. Бинарник
  собран без `--dotenv`, если вы осознанно не выбрали `.env` рядом с ним
  ([Файлы `.env`](secrets.md#файлы-env)).

## Ошибки, документация, health

- [ ] **`exposeErrorDetails` не включён.** Проверка: запрос, который
  падает, отвечает `{"error":"Internal Server Error"}`.
- [ ] **`/docs` выключена** (так по умолчанию) или закрыта снаружи —
  иначе любой получит карту всех маршрутов ([OpenAPI](../http/openapi.md)).
- [ ] **`/health` включён для оркестратора** — `http: { health: true }`.
  `exposeDetails` — только если адрес закрыт снаружи
  ([Health checks](../fundamentals/health-checks.md#подробности)).
- [ ] **Ответы на ошибки БД — по смыслу**, а не `500`:
  `errorHandler: { status: databaseErrorStatus }`
  ([Ошибки базы данных](../database/errors.md#http-статусы)).

## HTTP

- [ ] **TLS завершается на прокси или балансировщике**, сам сервер
  слушает HTTP. Включите HSTS:

  ```ts
  http: { securityHeaders: { hsts: true } }
  ```

  ```text
  Strict-Transport-Security: max-age=15552000; includeSubDomains
  ```

- [ ] **За прокси указаны `trustedProxies` — только адреса ваших
  прокси.** Тогда лимиты и журнал видят настоящий адрес клиента, а
  подделать его в обход прокси нельзя ([За nginx](../deployment/production.md#за-nginx)).
- [ ] **CORS — явный список источников.** `credentials: true` вместе с
  `origin: "*"` приложение не пропустит при запуске
  ([CORS](../http/cors-headers-log.md#cors)).
- [ ] **Лимит частоты на входе и других дорогих маршрутах:**

  ```ts
  @Post("login")
  @Middleware(rateLimit({ windowMs: 60_000, max: 5 }))
  login(body: LoginRequest) { ... }
  ```

  Счётчики хранятся в памяти экземпляра: у трёх экземпляров за
  балансировщиком лимит фактически втрое больше
  ([Ограничение частоты](../http/rate-limit.md)).
- [ ] **Журнал запросов включён** — `http: { accessLog: true }`. Путь
  пишется без строки запроса, поэтому токен из `?token=…` в журнал не
  попадёт; токены в самом пути (`/reset/<токен>`) — попадут.
- [ ] **Загрузка файлов — со своим пределом размера и проверкой типа**
  ([Файлы](../http/files.md)).

## Авторизация

Маршрут без `@Authorize` **открыт**, если не задана общая проверка
`runApp({ http: { authorize } })` ([Закрыто по
умолчанию](../overview/authorization.md#закрыто-по-умолчанию)). С ней открыты
только маршруты с `@AllowAnonymous`. Список открытых маршрутов всё равно
стоит закрепить тестом. Защищённые маршруты в документе OpenAPI отмечены
полем `security` — тест сравнивает остальные со списком:

```ts
// src/app/test/openRoutes.test.ts
import { expect, test } from "bun:test";
import { startTestApp } from "bazis/core/testing";
import { AppInfra } from "../infra/App.infra";
import { AppModule } from "../modules/App.module";

/** Маршруты, открытые намеренно. Новый маршрут без @Authorize уронит тест. */
const PUBLIC_ROUTES = ["GET /notes/anonymous", "POST /notes/login"];

test("every route except the public ones requires authorization", async () => {
  const app = await startTestApp(AppModule, { infra: AppInfra, http: { docs: true } });
  try {
    const spec = await (await app.fetch("/docs/openapi.json")).json() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    const open = Object.entries(spec.paths)
      .flatMap(([path, operations]) => Object.entries(operations)
        .filter(([, operation]) => !operation.security?.length)
        .map(([method]) => `${method.toUpperCase()} ${path}`))
      .sort();
    expect(open).toEqual(PUBLIC_ROUTES);
  } finally {
    await app.stop();
  }
});
```

Добавили контроллер и забыли `@Authorize`:

```text
error: expect(received).toEqual(expected)

  [
+   "GET /debug",
    "GET /notes/anonymous",
```

- [ ] **Открытые маршруты перечислены в тесте** (выше).
- [ ] **Ключ подписи JWT** — из секретов, для HS256 не короче 32 байт;
  сервис токенов создаётся при запуске, чтобы ошибка ключа остановила
  старт ([JWT: ключи](jwt.md#ключи)).
- [ ] **Короткий срок access-токена**, refresh-токены отзываются
  ([Обновление пары](jwt.md#обновление-пары)).
- [ ] **Данные арендаторов разделены фильтром запросов**, а не условием в
  каждом методе; чужая запись отвечает `404`
  ([Арендаторы](authorization-patterns.md#арендаторы)).
- [ ] **Ответы, зависящие от пользователя, кэшируются только с
  `varyByUser`** ([Кэш ответов](../http/output-cache.md#защищённые-маршруты)).

## База данных

- [ ] **TLS до базы с проверкой сервера:** `BAZIS_DB__TLS=verify-full`
  ([TLS](../database/postgresql.md#tls)).
- [ ] **Тайм-ауты заданы:** `operationTimeoutMs` и `lockTimeoutMs`
  ([Пул и тайм-ауты](../database/postgresql.md#пул-и-тайм-ауты)).
- [ ] **Приложение работает под пользователем без прав на схему.** Если
  кто-то получит доступ к приложению, он сможет читать и менять данные, но
  не удалить таблицы. Схему меняет владелец — отдельным шагом выкладки.

### Пользователь без прав на схему

Владелец (`app_owner`) создаёт таблицы, приложение (`app_rw`) работает
только с данными:

```sql
CREATE ROLE app_rw LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
-- и для таблиц, которые владелец создаст позже:
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
```

Выкладка — два шага одним и тем же бинарником:

```bash
# 1. Схема: миграции и ensureCreated под владельцем, затем выход
BAZIS_SCHEMA_ONLY=1 BAZIS_DB__USERNAME=app_owner BAZIS_DB__PASSWORD=… ./bin/my-app
```

```text
[orm:schema] applied 1 operation(s): add column notes.title
info: schema only: infrastructure and schema are ready, stopping (BAZIS_SCHEMA_ONLY) {"hostedServices":2,"startupMs":150.7}
```

```bash
# 2. Приложение под пользователем без прав на схему
BAZIS_DB__USERNAME=app_rw BAZIS_DB__PASSWORD=… ./bin/my-app
```

`BAZIS_SCHEMA_ONLY=1` запускает только подключения и схему — службы с
отрицательной фазой — и завершается с кодом `0`. HTTP, фоновые службы,
хуки жизненного цикла и события `APPLICATION_STARTED`/`STOPPING` не
запускаются. Ошибка миграции или схемы завершает шаг с кодом `1`, и
выкладка дальше не идёт. Из кода тот же режим — `kernel: { schemaOnly: true }`.

Если шаг схемы забыли, приложение под `app_rw` не запустится и скажет, что
делать:

```text
SchemaAdmissionError [ORM_SCHEMA_ADDITIVE_DDL_FAILED]: PostgreSQL additive schema admission failed:
add column notes.title failed with PostgreSQL 42501: must be owner of table notes. This database user
may not change the schema: apply the change with the schema owner's credentials (BAZIS_SCHEMA_ONLY=1
applies the schema and exits), or grant the rights.
```

Когда менять нечего, `app_rw` стартует сам: `ensureCreated` только
сверяет схему, а миграции, уже записанные в историю, не выполняются.

> [!NOTE]
> `BAZIS_SCHEMA_ONLY` и подсказка про права — с версии 0.98.30. Раньше
> приложение с миграциями не запускалось под пользователем без прав на
> схему, даже когда выполнять было нечего:
> `permission denied for schema public`.

## Сборка и зависимости

- [ ] **`bun.lock` в git**, версии зависимостей закреплены.
- [ ] **Нет известных уязвимостей:**

  ```bash
  bun audit
  ```

  ```text
  No vulnerabilities found (checked 6 packages)
  ```

- [ ] **Тест запуска как в production** (`src/app/test/health.test.ts` из
  `bazis new`) не удалён: он ловит ошибки в `src/index.ts`
  ([Тестирование](../fundamentals/testing.md#запуск-как-в-production)).
- [ ] **Бинарник запускается не от root** и не может писать в свой каталог.

## Дальше

- [Секреты и конфигурация](secrets.md)
- [Шаблоны авторизации](authorization-patterns.md)
- [Аутентификация через JWT](jwt.md)
- [CORS, заголовки безопасности, журнал запросов](../http/cors-headers-log.md)
