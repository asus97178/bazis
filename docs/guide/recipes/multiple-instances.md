# Несколько экземпляров приложения с Redis

Planner из предыдущих рецептов запускается в двух экземплярах за
балансировщиком. Что работает само, что живёт в памяти процесса и как
через Redis сделать общими кэш ответов и уведомления по WebSocket.

Проверено на bazis 0.100.4, PostgreSQL 17 и Valkey 7.2.

## Что общее, а что нет

| Что | На нескольких экземплярах |
| --- | --- |
| Данные в PostgreSQL | Общие |
| JWT | Работает на любом экземпляре: токен проверяется ключом из настроек, сессий на сервере нет |
| Фоновая служба | Работает в каждом экземпляре; напоминания не дублируются за счёт `skipLocked` ([рецепт](background-job.md)) |
| `@Cacheable`, `@OutputCache`, `memory()` | Свой кэш у каждого экземпляра |
| `@CacheableRedis`, `@OutputRedisCache` | Общий кэш в Redis |
| Комнаты и сессии WebSocket | В памяти процесса; общие — с адаптером Redis |
| `rateLimit` | Свои счётчики у каждого экземпляра ([Ограничение частоты](../http/rate-limit.md#как-считается)) |

## 1. Redis

```ts
// src/app/config/redis.config.ts
import { defineConfig, secret, type Secret } from "bazis/core/kernel";

export interface RedisConfig { url: Secret }

export const redisConfig = defineConfig<RedisConfig>("redis", {
  default: { url: secret("redis://127.0.0.1:6379") },
  production: { url: secret() },
});
```

```ts
// src/app/infra/App.infra.ts
import { Infra, redisConnect } from "bazis/core/infra";
import { ormBazisConnect } from "bazis/core/orm";
import { dbConfig } from "../config/db.config";
import { redisConfig } from "../config/redis.config";

@Infra({
  db: ormBazisConnect(dbConfig),
  cache: redisConnect(redisConfig, { cache: "distributed" }),
})
export class AppInfra {}
```

`cache: "distributed"` публикует общий кэш поверх этого подключения.
Модуль `memory()` для него не нужен.

## 2. Общий кэш списка задач

```ts
// tasks/http/Tasks.controller.ts
import { OutputRedisCache } from "bazis/core/cache";

  @Get()
  @OutputRedisCache({ seconds: 30, varyByQuery: "*", varyByUser: true, tags: ["tasks"] })
  async list(query: TasksListQuery, ctx: HttpContext) { … }
```

Маршрут защищён, поэтому у каждого пользователя своя запись
(`varyByUser`) — иначе приложение не стартует
([Защищённые маршруты](../http/output-cache.md#защищённые-маршруты)).

После каждой записи сервис сбрасывает тег — на всех экземплярах:

```ts
// tasks/services/Tasks.service.ts
import { IDistributedCache } from "bazis/core/cache";

export class TasksService implements ITasksService {
  constructor(
    private readonly db: TasksDbContext,
    private readonly current: CurrentUser,
    private readonly cache: IDistributedCache,
  ) {}

  async create(body: CreateTaskRequest): Promise<TaskResponse> {
    // …
    this.db.tasks.add(task);
    await this.db.saveChanges();
    await this.cache.evictByTag("tasks");
    return toTaskResponse(task);
  }
  // update и delete — так же, после saveChanges()
}
```

`IDistributedCache.evictByTag` сбрасывает тег и в значениях
`@CacheableRedis`, и в ответах `@OutputRedisCache`.

Проверено на двух экземплярах, A и B, с одинаковым `Host`, как за
балансировщиком:

```text
A  GET /tasks   total=1   Cache-Control: private               посчитал A
B  GET /tasks   total=1   Age: 1  Cache-Control: private       B взял ответ A из Redis
B  POST /tasks  201                                             сброс тега "tasks"
A  GET /tasks   total=2   Cache-Control: private               посчитано заново
```

> [!NOTE]
> Ключ записи включает адрес запроса вместе с хостом. Экземпляры за
> балансировщиком получают один `Host` и делят записи. Если обращаться к
> каждому экземпляру по его порту, записи у них будут разные.

## 3. Уведомления по WebSocket

Напоминание из [фоновой задачи](background-job.md) уходит пользователю
сразу, если он подключён, — к какому бы экземпляру ни было его
соединение.

```ts
// tasks/http/Notifications.gateway.ts
import { WebSocketGateway, type BazisSocket } from "bazis/core/websocket";

/** ws://host/ws/notifications: each user gets their notifications live. */
@WebSocketGateway({ namespace: "notifications" })
export class NotificationsGateway {
  handleConnection(socket: BazisSocket) {
    socket.join(`user:${socket.data.user?.id}`);
  }
}
```

```ts
// tasks/Tasks.module.ts
  controllers: [TasksController, NotificationsController],
  gateways: [NotificationsGateway],
```

Сервис напоминаний отправляет событие в личную комнату — после фиксации
транзакции:

```ts
// tasks/services/Reminders.service.ts
import { WebSocketService } from "bazis/core/websocket";

export class RemindersService {
  constructor(private readonly db: TasksDbContext, private readonly ws: WebSocketService) {}

  async sendDue(now: Date = new Date()): Promise<number> {
    return this.db.transactionScope(async () => {
      // … выборка задач как раньше
      const created: Notification[] = [];
      for (const task of due) {
        task.remindedAt = now;
        const notification = Object.assign(new Notification(), {
          userId: task.ownerId,
          taskId: task.id,
          text: `"${task.title}" is due at ${task.dueAt?.toISOString()}`,
        });
        this.db.notifications.add(notification);
        created.push(notification);
      }
      await this.db.saveChanges();
      // After the commit: the user's open connections get it right away,
      // whichever instance they are connected to.
      for (const notification of created) {
        this.ws.to(`user:${notification.userId}`).emit("reminder", { taskId: notification.taskId, text: notification.text });
      }
      return due.length;
    });
  }
}
```

Вход по токену и адаптер Redis — в `runApp`. Оба берут сервисы
приложения: проверка — `AuthTokens` из модуля `auth`, адаптер — клиент
Redis из `@Infra`:

```ts
// src/index.ts
import { IRedis } from "bazis/core/infra";
import { RedisWebSocketAdapter } from "bazis/core/websocket";
import { AuthTokens } from "./app/modules/auth/AuthTokens.service";

await runApp(AppModule, {
  infra: AppInfra,
  websocket: {
    requireAuth: true,
    cors: { origins: (process.env.APP_ORIGINS ?? "http://localhost:5173").split(",") },
    adapter: (services) => new RedisWebSocketAdapter(services.resolve(IRedis)),
    authenticator: async (token, context) => {
      if (!token) return null;
      const { payload } = await context!.services!.resolve(AuthTokens).issuer.verifyAccess(token);
      return { id: String(payload.sub) };
    },
  },
  http: { … },
});
```

### Redis для доставки

Адаптер хранит сессии и неотправленные сообщения в Redis и требует, чтобы
Redis не терял записи: журнал AOF с записью на каждую операцию и без
вытеснения ключей. Иначе приложение не стартует:

```text
[bazis] application failed: WebSocketDeliveryError [DURABILITY_CONFIGURATION]: WebSocket delivery rejected: DURABILITY_CONFIGURATION.
```

Настройки Redis или Valkey:

```text
appendonly yes
appendfsync always
maxmemory-policy noeviction
no-appendfsync-on-rewrite no
```

Например, `valkey-server --appendonly yes --appendfsync always --maxmemory-policy noeviction`.
В лаборатории их включили на работающем сервере командой `CONFIG SET`.

### Проверка

Ann подключилась к экземпляру B и создала задачу со сроком через 30
минут. Затем запущен экземпляр A — его первый тик отправил напоминание:

```text
ws <- {"v":1,"type":"connected","sid":"f6bd6d74-…","namespace":"/notifications","data":{"userId":"c8fa199c-…"}}
ws <- {"v":1,"type":"event","namespace":"/notifications","event":"reminder",
       "data":{"taskId":"625ece07-…","text":"\"Call the bank\" is due at 2026-10-15T22:59:15.000Z"}}

reminders sent — в журнале A: 1, в журнале B: 0
```

Подключение с неверным токеном отклоняется (`401`, клиент получает
ошибку соединения).

## Тесты

Тесты запускают приложение с тем же `AppInfra`, поэтому им тоже нужен
Redis. Адаптер WebSocket и вход по токену задаются в `src/index.ts` и в
`startTestApp` не попадают: в тесте работает адаптер в памяти.

```text
$ bunx bazis test
 8 pass
 0 fail
    ✔  SUCCESS   all tests passed · 2.1 s
```

## Дальше

- [Кэширование](../realtime/caching.md) — `@CacheableRedis`, недоступный Redis
- [Кэш ответов](../http/output-cache.md)
- [WebSocket](../realtime/websocket.md)
- [Плавная остановка и health](../deployment/graceful-shutdown.md)
