# Подключение PostgreSQL

ORM bazis работает с PostgreSQL через встроенный драйвер Bun — внешних
пакетов не нужно. Подключение — это три части: настройки, манифест
инфраструктуры и строчка в `runApp`.

Все примеры проверены на bazis 0.98.12 и PostgreSQL 17.

## Настройки

```ts
// src/app/config/db.config.ts
import { configEnum, defineConfig, secret, type Secret } from "bazis/core/kernel";
import type { PostgresSslMode } from "bazis/core/infra";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  password: Secret;
  tls: PostgresSslMode;
}

export const dbConfig = defineConfig<DbConfig>("db", {
  default: {
    host: "127.0.0.1",
    port: 5432,
    database: "app",
    username: "postgres",
    password: secret("postgres"),
    tls: configEnum(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"], "disable"),
  },
  production: {
    password: secret(),
    tls: "verify-full",
  },
});
```

Каждое значение переопределяется переменной окружения
`BAZIS_DB__<КЛЮЧ>`: `BAZIS_DB__HOST`, `BAZIS_DB__PASSWORD`,
`BAZIS_DB__TLS`. В `production` у пароля нет значения по умолчанию —
без переменной приложение не запустится:

```text
[bazis] configuration error: Invalid configuration (environment "production"):
db.password — required non-empty secret is not set (BAZIS_DB__PASSWORD).
```

Подробнее о `defineConfig`, окружениях и секретах — в главе
[Конфигурация](../fundamentals/configuration.md).

## Инфраструктура

```ts
// src/app/infra/App.infra.ts
import { Infra } from "bazis/core/infra";
import { ormBazisConnect } from "bazis/core/orm";
import { dbConfig } from "../config/db.config";

@Infra({ db: ormBazisConnect(dbConfig) })
export class AppInfra {}
```

```ts
// src/index.ts
await runApp(AppModule, { infra: AppInfra, http: { port: 3000, health: true } });
```

`ormBazisConnect` открывает пул соединений **до** HTTP-сервера, проверяет
базу запросом `SELECT 1` и публикует подключение для всех модулей.
Модуль с данными подключает к нему свой контекст:

```ts
@Module({
  ormBazis: { context: TaskDbContext, entities: [Task], ensureCreated: true },
  controllers: [TaskController],
  providers: [scoped(ITaskService, TaskService)],
  exports: [ITaskService],
})
export class TaskModule {}
```

Что такое контекст и сущности — в следующих главах.

## Если подключиться не удалось

Приложение не запускается и называет, куда подключалось и почему:

| Причина | Сообщение |
| --- | --- |
| Неверный пароль | `cannot connect to PostgreSQL at 127.0.0.1:5432 (database "app", user "postgres"): password authentication failed for user "postgres" (28P01)` |
| Нет такой базы | `… (database "shop", …): database "shop" does not exist (3D000)` |
| Сервер не запущен или неверный хост | `… at db:5432 …: Failed to connect (ERR_POSTGRES_CONNECTION_REFUSED)` |
| `tls: require`, а сервер без SSL | `…: Server does not support SSL (ERR_POSTGRES_TLS_NOT_AVAILABLE)` |

Пароль в сообщение не попадает. Неверное значение настройки останавливает
запуск ещё раньше:

```text
db.tls — "strict" is not allowed, use one of: disable, allow, prefer, require, verify-ca, verify-full (BAZIS_DB__TLS)
db.port — expected a finite number, got "abc" (BAZIS_DB__PORT)
```

> [!NOTE]
> Причина ошибки подключения и значения в сообщениях о настройках — с
> версии 0.98.12. Раньше любая проблема подключения давала одно и то же
> `postgres is not reachable.`

Приложение не ждёт базу при запуске: если она ещё не готова (например, в
`docker compose` контейнеры стартуют одновременно), процесс завершится с
ошибкой. Перезапустите его средствами окружения — `restart: on-failure`
в compose, политикой перезапуска в Kubernetes или systemd.

## Пока приложение работает

| Событие | Что происходит |
| --- | --- |
| База пропала | Запросы, которым нужна база, получают `500`; `/health` — `503` с `infra:db` `healthy: false` |
| База вернулась | Пул переподключается сам, перезапуск не нужен |
| Остановка приложения | Пул закрывается после HTTP-сервера |

```json
{"healthy":false,"checks":[{"name":"infra:db","healthy":false,"durationMs":1.5}]}
```

## TLS

| `tls` | Что значит |
| --- | --- |
| `disable` | Без шифрования — для локальной разработки |
| `prefer`, `allow` | Шифровать, если сервер умеет |
| `require` | Только с шифрованием, сертификат не проверяется |
| `verify-ca` | Проверить, что сертификат подписан доверенным центром |
| `verify-full` | Как `verify-ca` и проверить имя сервера — для продакшена |

Сертификат своего центра (облачные базы часто дают свой CA) — строковое
поле `tlsCa` с текстом сертификата, только вместе с `tls: "verify-full"`.
Пустая строка — без своего центра:

```ts
default: { ..., tlsCa: "" },          // в продакшене — переменная BAZIS_DB__TLSCA
```

`tlsCa` без `verify-full` — ошибка при запуске:
`tlsCa requires a non-empty certificate and tls=verify-full.`

## Пул и тайм-ауты

Эти поля добавляются в `DbConfig` и `default`, как остальные:

| Поле | Что задаёт |
| --- | --- |
| `max` | Сколько соединений держать в пуле |
| `connectionTimeout` | Тайм-аут установки соединения, секунды |
| `idleTimeout` | Через сколько секунд закрывать простаивающее соединение; `0` — не закрывать |
| `maxLifetime` | Максимальный срок жизни соединения, секунды |
| `operationTimeoutMs` | Предел любой операции с базой, включая ожидание соединения; по умолчанию 30 000 мс. Запрос, превысивший его, отменяется на сервере |
| `maxPendingOperations` | Сколько операций может ждать свободного соединения; по умолчанию 256 |
| `statementTimeoutMs` | `statement_timeout` внутри транзакций ORM |
| `lockTimeoutMs` | `lock_timeout` внутри транзакций ORM: сколько ждать блокировку |
| `idleInTransactionTimeoutMs` | Сколько транзакция может простаивать |
| `transactionTimeoutMs` | Предел всей транзакции; PostgreSQL 17+ |

```ts
default: { ..., max: 10, operationTimeoutMs: 5_000, lockTimeoutMs: 2_000 },
```

Серверные пределы (`statementTimeoutMs` и следующие) ставятся на время
транзакции ORM — `saveChanges`, `transactionScope` — и не переходят на
соединение после неё. Запросы вне транзакции ограничивает
`operationTimeoutMs`.

Неверное значение — ошибка при запуске:
`postgres max must be an integer 1..2147483647`.

Строки подключения вида `postgres://user:pass@host/db` (`DATABASE_URL`)
нет — каждое поле задаётся своей переменной `BAZIS_DB__*`.

## Локальная база в Docker

```bash
docker run -d --name app-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app -p 127.0.0.1:5432:5432 postgres:17-alpine
```

С настройками из примера выше приложение подключится к ней без
переменных окружения.

## Дальше

- [Конфигурация](../fundamentals/configuration.md)
- [Health checks](../fundamentals/health-checks.md)
- [Сущности и ключи](entities.md)
