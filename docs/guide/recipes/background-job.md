# Фоновая задача с базой данных

Напоминания о задачах проекта Planner из рецептов [CRUD](crud-module.md) и
[JWT](jwt-auth.md): раз в минуту служба находит открытые задачи, срок
которых наступает в ближайший час, и пишет владельцу уведомление.
Напоминание приходит один раз, даже когда приложение запущено в
нескольких экземплярах.

Проверено на bazis 0.100.3 и PostgreSQL 17.

## 1. Данные

У задачи — отметка, что напоминание уже отправлено:

```ts
// tasks/model/Tasks.model.ts — новое поле
  @Column({ type: "datetime", nullable: true })
  remindedAt: Date | null = null;
```

Уведомление — отдельная таблица в том же контексте базы, чтобы
уведомление и отметка в задаче записывались в одной транзакции:

```ts
// tasks/model/Notification.model.ts
import { Column, Entity, Index, Required, UUID } from "bazis/core/orm";

@Entity({ table: "notifications" })
export class Notification {
  @UUID()
  id = "";

  @Required()
  @Index()
  @Column({ type: "text" })
  userId = "";

  @Required()
  @Column({ type: "text" })
  taskId = "";

  @Required()
  @Column({ type: "text" })
  text = "";

  @Column({ type: "createdAt" })
  createdAt = new Date(0);
}
```

```ts
// tasks/model/Tasks.dbContext.ts
export class TasksDbContext extends DbContext {
  readonly tasks = this.set(Task);
  readonly notifications = this.set(Notification);
}
```

> [!WARNING]
> Новый столбец в уже созданной таблице `tasks` — изменение схемы:
> `ensureCreated` его не добавит и остановит запуск
> ([Управление схемой](../database/schema.md)). Для учебной базы удалите
> таблицу.

## 2. Сервис

Вся логика — в scoped-сервисе. Его можно вызвать из фоновой службы, из
теста или из маршрута администратора.

```ts
// tasks/services/Reminders.service.ts
import { Notification } from "../model/Notification.model";
import { TasksDbContext } from "../model/Tasks.dbContext";

const HOUR_MS = 60 * 60 * 1000;

export class RemindersService {
  constructor(private readonly db: TasksDbContext) {}

  /**
   * One reminder per open task due within the next hour. The task is locked
   * while its reminder is written, so two instances never remind twice.
   */
  async sendDue(now: Date = new Date()): Promise<number> {
    return this.db.transactionScope(async () => {
      const due = await this.db.tasks
        .where((t) => t.done.eq(false).and(t.remindedAt.isNull()).and(t.dueAt.lte(new Date(now.getTime() + HOUR_MS))))
        .orderBy((t) => t.dueAt)
        .orderBy((t) => t.id)          // skipLocked needs the key in the order
        .take(100)
        .forUpdate({ skipLocked: true })
        .toList();
      for (const task of due) {
        task.remindedAt = now;
        this.db.notifications.add(Object.assign(new Notification(), {
          userId: task.ownerId,
          taskId: task.id,
          text: `"${task.title}" is due at ${task.dueAt?.toISOString()}`,
        }));
      }
      await this.db.saveChanges();
      return due.length;
    });
  }

  mine(userId: string): Promise<Notification[]> {
    return this.db.notifications.asNoTracking().where((n) => n.userId.eq(userId)).orderBy((n) => n.createdAt).toList();
  }
}
```

- **`transactionScope`** — выборка, отметки и уведомления фиксируются
  вместе. Упало посреди — откатится всё, и задачи останутся
  неотмеченными до следующего раза.
- **`forUpdate({ skipLocked: true })`** блокирует выбранные задачи до конца
  транзакции, а другой экземпляр их пропускает
  ([Транзакции](../database/transactions.md#очередь-задач-skiplocked)).
- **`remindedAt.isNull()`** — уже отмеченная задача больше не попадёт в
  выборку.
- **`take(100)`** — одна транзакция не держит тысячи строк; остальные
  задачи возьмёт следующий тик.
- **`now` — параметр**: тест передаёт своё время.

Без ключа в сортировке ORM откажется выполнять запрос:

```text
error: background TaskReminders tick failed {"service":"TaskReminders","error":{"name":"Error",
  "message":"FOR UPDATE SKIP LOCKED requires an explicit complete primary-key order.",…}}
```

## 3. Служба

```ts
// tasks/TaskReminders.ts
import { Background, PeriodicBackgroundService } from "bazis/core/background";
import type { ServiceProvider } from "bazis/core/di";
import type { Logger } from "bazis/core/kernel";
import { RemindersService } from "./services/Reminders.service";

@Background({ intervalMs: 60_000, restart: { maxRestarts: 100, maxBackoffMs: 60_000 } })
export class TaskReminders extends PeriodicBackgroundService {
  constructor(private readonly provider: ServiceProvider, private readonly logger: Logger) {
    super();
  }

  protected override async tick(): Promise<void> {
    const scope = this.provider.createScope();
    try {
      const sent = await scope.resolve(RemindersService).sendDue();
      if (sent > 0) this.logger.info("reminders sent", { sent });
    } finally {
      await scope.dispose();
    }
  }
}
```

- Первый тик — сразу при запуске, следующие — через минуту после
  окончания предыдущего.
- Служба тонкая: на каждый тик своя область DI, свой контекст базы, и он
  закрывается в `finally`.
- Упавший тик пишется в журнал, расписание продолжается. Перезапуски с
  запасом — чтобы временный сбой базы не вывел экземпляр из балансировки
  ([Здоровье](../realtime/background-services.md#здоровье)).

## 4. Уведомления в API

```ts
// tasks/http/Notifications.controller.ts
import { Authorize, Controller, Get } from "bazis/core/http";
import { CurrentUser } from "../../auth/CurrentUser";
import { requireTokenKind } from "../../auth/jwtAuth";
import { TokenKind } from "../../auth/tokenKinds";
import { RemindersService } from "../services/Reminders.service";

@Controller("notifications")
@Authorize(requireTokenKind(TokenKind.Admin, TokenKind.Client))
export class NotificationsController {
  constructor(private readonly reminders: RemindersService, private readonly current: CurrentUser) {}

  @Get()
  async mine() {
    const items = await this.reminders.mine(this.current.get().id);
    return items.map(({ id, taskId, text, createdAt }) => ({ id, taskId, text, createdAt }));
  }
}
```

## 5. Модуль

```ts
// tasks/Tasks.module.ts
@Module({
  imports: [AuthModule],
  ormBazis: {
    context: TasksDbContext,
    entities: [Task, Notification],
    ensureCreated: true,
  },
  controllers: [TasksController, NotificationsController],
  providers: [
    scoped(ITasksService, TasksService),
    scoped(RemindersService),
  ],
  background: [TaskReminders],
  exports: [ITasksService],
})
export class TasksModule {}
```

Служба появилась в `/health`:

```json
{"healthy":true,"checks":[
  {"name":"infra:db","healthy":true,…},
  {"name":"background:AdminSeed","healthy":true,…},
  {"name":"background:TaskReminders","healthy":true,…}]}
```

## 6. Проверка

У Ann три задачи: срок через 30 минут, через 3 часа и без срока. Два
экземпляра приложения запускаются одновременно, и оба делают первый тик
сразу:

```text
r1.log: info: reminders sent {"sent":1}
r2.log: (ничего — задача уже отмечена или заблокирована первым)

$ curl localhost:3000/notifications -H "authorization: Bearer $ANN"
[{"id":"a220a335-…","taskId":"9e744c28-…","text":"\"Call the bank\" is due at 2026-10-15T12:32:21.000Z","createdAt":"2026-10-15T12:02:46.224Z"}]
```

Проверено пять раз подряд со сбросом отметок: в каждом раунде одно
уведомление, отправил его то один экземпляр, то другой.

## 7. Тест

Сервис вызывается напрямую, со своим временем, — тест не ждёт минуту и
не зависит от часов:

```ts
// tasks/test/reminders.test.ts
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { DATABASE_PROVIDER } from "bazis/core/orm";
import type { TestApp } from "bazis/core/testing";
import { startPlanner } from "../../../test/testApp";
import { RemindersService } from "../services/Reminders.service";

let app: TestApp;
let token = "";

beforeAll(async () => {
  app = await startPlanner();
  const login = await app.fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@planner.local", password: "dev-admin-password" }),
  });
  token = ((await login.json()) as { accessToken: string }).accessToken;
});
afterAll(async () => {
  await app.stop();
});
beforeEach(async () => {
  const db = app.container.resolve(DATABASE_PROVIDER);
  await db.execute("DELETE FROM notifications", []);
  await db.execute("DELETE FROM tasks", []);
});

async function task(title: string, dueAt?: Date) {
  await app.fetch("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, ...(dueAt ? { dueAt: dueAt.toISOString() } : {}) }),
  });
}

async function sendDue(now: Date): Promise<number> {
  const scope = app.container.createScope();
  try {
    return await scope.resolve(RemindersService).sendDue(now);
  } finally {
    await scope.dispose();
  }
}

test("a task due within an hour gets one reminder, once", async () => {
  const now = new Date("2026-10-15T12:00:00Z");
  await task("Call the bank", new Date("2026-10-15T12:30:00Z"));
  await task("Write report", new Date("2026-10-15T15:00:00Z"));
  await task("No deadline");

  expect(await sendDue(now)).toBe(1);
  expect(await sendDue(now)).toBe(0);

  const response = await app.fetch("/notifications", { headers: { authorization: `Bearer ${token}` } });
  const notifications = await response.json() as { text: string }[];
  expect(notifications.map((item) => item.text)).toEqual(['"Call the bank" is due at 2026-10-15T12:30:00.000Z']);

  // Two hours later the report is due too.
  expect(await sendDue(new Date("2026-10-15T14:30:00Z"))).toBe(1);
});
```

```text
$ bunx bazis test
 8 pass
 0 fail
    ✔  SUCCESS   all tests passed · 1.4 s
```

`startPlanner` — помощник из [рецепта JWT](jwt-auth.md#10-тест).

## Дальше

- [Фоновые службы](../realtime/background-services.md) — очередь задач,
  «ровно один раз за период», блокировки
- [Жизненный цикл](../fundamentals/lifecycle.md#фоновые-службы)
- [Несколько экземпляров с Redis](multiple-instances.md)
