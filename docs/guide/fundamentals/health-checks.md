# Health checks

`GET /health` отвечает, готово ли приложение работать: Docker, Kubernetes
и балансировщики спрашивают его и не шлют запросы туда, где что-то
сломалось. bazis собирает ответ из проверок, которые регистрируют
модули.

Все примеры проверены на bazis 0.97.11.

## Включение

```ts
await runApp(AppModule, { http: { port: 3000, health: true } });
```

```text
GET /health → 200 {"healthy":true,"checks":[]}
```

`bazis new` включает его сразу. Маршрут обслуживается до маршрутизации и
middleware приложения: глобальная проверка ключа или авторизация его не
закрывают, а журнал запросов и заголовки безопасности к нему применяются.

## Своя проверка

Проверка — класс с именем и методом `check`, зарегистрированный под
`HEALTH_CHECK`. Зависимости приходят через конструктор, как у любого
сервиса:

```ts
import type { HealthCheck, HealthCheckResult } from "bazis/core/kernel";

export class QueueHealth implements HealthCheck {
  readonly name = "queue";

  constructor(private readonly queue: QueueClient) {}

  async check(): Promise<HealthCheckResult> {
    if (!(await this.queue.ping())) return { healthy: false, details: "queue is unreachable" };
    return { healthy: true, details: `backlog ${this.queue.backlog}` };
  }
}
```

```ts
import { HEALTH_CHECK } from "bazis/core/kernel";

@Module({
  providers: [singleton(QueueClient), singleton(HEALTH_CHECK, QueueHealth)],
  exports: [],
})
export class QueueModule {}
```

Проверок может быть сколько угодно — в одном модуле и в разных.

## Ответ

```json
{"healthy":true,"checks":[
  {"name":"queue","healthy":true,"durationMs":0.64},
  {"name":"disk","healthy":true,"durationMs":0.43}
]}
```

| Ситуация | Код | `healthy` проверки |
| --- | --- | --- |
| Все проверки в порядке | `200` | `true` |
| Проверка вернула `healthy: false` | `503` | `false` |
| Проверка бросила исключение | `503` | `false` |
| Проверка не уложилась в 1 секунду | `503` | `false`, `details: "Health check timed out."` |

Достаточно одной неуспешной проверки, чтобы весь ответ стал `503`.

## Подробности

`details` по умолчанию **не** попадают в ответ: `/health` обычно открыт
без авторизации, а в подробностях бывают адреса, размеры очередей, тексты
ошибок. Включите их, если маршрут закрыт снаружи:

```ts
http: { health: { exposeDetails: true } }
```

```json
{"healthy":false,"checks":[
  {"name":"queue","healthy":true,"details":"backlog 3","durationMs":0.57},
  {"name":"disk","healthy":false,"details":"statfs failed: password=***","durationMs":0.41}
]}
```

Текст исключения попадает в `details`, секреты в нём маскируются.

## Настройки

```ts
http: { health: { path: "/ready", exposeDetails: false, timeoutMs: 5000, cacheMs: 2000 } }
```

| Опция | По умолчанию | Что задаёт |
| --- | --- | --- |
| `path` | `/health` | Путь маршрута |
| `exposeDetails` | `false` | Показывать `details` |
| `timeoutMs` | `5000` | Предел на весь ответ; `0` — без предела |
| `cacheMs` | `0` | Сколько миллисекунд отдавать готовый отчёт без новых проверок |

Каждая проверка ограничена 1 секундой, проверки выполняются параллельно —
не больше четырёх одновременно. Если проверки дорогие, а опрашивают часто,
включите `cacheMs`: повторные запросы в течение этого времени получат тот
же отчёт. Одновременные запросы и так не запускают проверки повторно —
они ждут один общий результат.

Проверка получает `signal`: он отменяется, когда время вышло. Передайте
его дальше — в запрос к базе или `fetch`, — чтобы зависшая проверка не
продолжала работать впустую.

## Проверки, которые добавляются сами

| Что подключено | Проверка |
| --- | --- |
| `cache: memory()` | `cache:memory` |
| Подключения из `infra` (PostgreSQL, Redis) | Своя проверка на каждое подключение |
| ORM | Доступность базы данных |

## Что проверять

Проверяйте то, без чего приложение не может обслуживать запросы: базу
данных, брокер очередей, обязательный внешний сервис. Не проверяйте
необязательные зависимости — если без них приложение работает, пусть
`/health` остаётся зелёным, а проблему видно в журнале. Иначе один
недоступный сервис рассылки выведет из балансировки все экземпляры.

## Дальше

- [Приложение](../overview/application.md)
- [Логирование и correlation id](logging.md)
- [Тестирование](testing.md)
