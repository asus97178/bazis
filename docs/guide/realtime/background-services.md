# Фоновые службы

Как устроены фоновые службы — `BackgroundService`,
`PeriodicBackgroundService`, отмена, перезапуск, параметры, — рассказано
в главе [Жизненный цикл](../fundamentals/lifecycle.md#фоновые-службы).
Здесь — задачи, которые с ними решают на практике: очередь задач в
базе, работа на нескольких экземплярах приложения и наблюдение за
службами через `/health`.

Все примеры проверены на bazis 0.110.1 и PostgreSQL 17.

## Очередь задач в базе

Задачу кладёт HTTP-запрос, выполняет фоновый обработчик. Таблица задач —
обычная сущность:

```ts
@Entity({ table: "jobs" })
export class Job {
  @Key() id = 0;
  @Column({ type: "text" }) kind = "";
  @Column({ type: "text" }) payload = "";
  @Column({ type: "text" }) status: "new" | "done" | "failed" = "new";
  @Column({ type: "integer" }) attempts = 0;
}
```

Логику держите в `scoped`-сервисе, а фоновую службу оставьте тонкой: она
только крутит цикл и создаёт область DI на каждую задачу.

```ts
export class JobsService {
  constructor(private readonly db: JobsDb, private readonly mailer: Mailer) {}

  /** Берёт одну свободную задачу и выполняет её; false — очередь пуста. */
  async processNext(signal: AbortSignal): Promise<boolean> {
    return this.db.transactionScope(async () => {
      const job = await this.db.jobs
        .where((j) => j.status.eq("new"))
        .orderBy((j) => j.id)
        .take(1)
        .forUpdate({ skipLocked: true })
        .firstOrDefault();
      if (!job) return false;
      job.attempts += 1;
      try {
        await this.mailer.send(job.payload, signal);
        job.status = "done";
      } catch (error) {
        if (signal.aborted) throw error;          // остановка: откатить, задача останется в очереди
        job.status = job.attempts >= 3 ? "failed" : "new";
      }
      await this.db.saveChanges();
      return true;
    });
  }
}

@Background({ restart: { maxRestarts: 5 } })
export class JobsWorker extends BackgroundService {
  constructor(private readonly provider: ServiceProvider) { super(); }

  protected override async execute(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const scope = this.provider.createScope();
      let worked = false;
      try {
        worked = await scope.resolve(JobsService).processNext(signal);
      } finally {
        await scope.dispose();
      }
      if (!worked) await delay(500, signal);   // очередь пуста — подождать
    }
  }
}

@Module({
  ormBazis: { context: JobsDb, entities: [Job], ensureCreated: true },
  providers: [scoped(JobsService)],
  controllers: [JobsController],
  background: [JobsWorker],
})
export class JobsModule {}
```

Как это работает:

- `forUpdate({ skipLocked: true })` блокирует взятую строку до конца
  транзакции, а другие обработчики её пропускают
  ([Очередь задач: `skipLocked`](../database/transactions.md#очередь-задач-skiplocked)).
  Проверено: два экземпляра приложения разобрали 10 задач между собой (7 и
  3 — кто раньше взял), ни одна не выполнилась дважды.
- Задача выполняется внутри транзакции. Если обработчик упал или
  приложение остановили на середине, транзакция откатывается, и задача
  снова `new` — её возьмёт следующий обработчик.
- Неудачная попытка возвращает задачу в очередь; после трёх — `failed`.

Проверено остановкой посреди задачи:

```text
POST /jobs {"payload":"slow"}     → {"id":25,"status":"new","attempts":0}
SIGTERM через 0,8 с
SELECT … WHERE id = 25            → 25 | slow | new | 0
```

Держите задачи короткими: пока задача выполняется, открыта транзакция и
занято соединение пула. Долгую работу лучше разбить на шаги, каждый со
своей записью о прогрессе.

> [!WARNING]
> `delay(ms, signal)` при отмене **не бросает** ошибку, а просто
> завершается раньше. Если пауза — часть работы, после неё проверьте
> `signal.throwIfAborted()`, иначе прерванная работа будет сохранена как
> выполненная. `fetch`, запросы к базе и другие операции с `signal`
> бросают ошибку сами.

## Несколько экземпляров

Фоновая служба работает в каждом процессе. На трёх экземплярах за
балансировщиком периодическая задача выполняется три раза за интервал.
Что с этим делать, зависит от задачи:

| Задача | Решение |
| --- | --- |
| Повтор безвреден: очистка, пересчёт кэша | Ничего: второй экземпляр просто ничего не найдёт |
| Очередь задач | `skipLocked` — см. выше |
| Ровно один раз за период: ежедневный отчёт | Уникальная запись периода — `insertIfAbsent` |
| Не одновременно: переиндексация | Блокировка PostgreSQL `pg_try_advisory_xact_lock` |

### Ровно один раз за период

Каждый экземпляр пытается вставить запись «отчёт за сегодня». Уникальный
индекс пропустит только первую — кто вставил, тот и отправляет:

```ts
@Entity({ table: "report_runs" })
export class ReportRun {
  @Key() id = 0;
  @Index({ unique: true }) @Column({ type: "text" }) period = "";
}

@Background({ intervalMs: 60_000 })
export class DailyReport extends PeriodicBackgroundService {
  constructor(private readonly provider: ServiceProvider) { super(); }

  protected override async tick(): Promise<void> {
    const period = new Date().toISOString().slice(0, 10);       // "2026-10-11"
    const scope = this.provider.createScope();
    try {
      const { inserted } = await scope.resolve(ReportsDb).reportRuns.insertIfAbsent(
        Object.assign(new ReportRun(), { period }),
        { conflictBy: (r) => [r.period] },
      );
      if (inserted) await scope.resolve(ReportsService).send(period);
    } finally {
      await scope.dispose();
    }
  }
}
```

Проверено на двух экземплярах с тиком раз в секунду: за каждый период в
таблице одна строка, отчёт отправлен один раз. Запись остаётся
историей: когда и за какой период отчёт ушёл.

Если отправка упала после вставки, отчёт за этот период не повторится.
Когда это важно, храните в записи статус и повторяйте неотправленные —
это уже очередь задач.

### Не одновременно

Блокировка PostgreSQL, связанная с транзакцией, держится до её конца и
снимается сама — даже если процесс упал:

```ts
@Background({ intervalMs: 300_000 })
export class Reindex extends PeriodicBackgroundService {
  constructor(private readonly provider: ServiceProvider) { super(); }

  protected override async tick(signal: AbortSignal): Promise<void> {
    const scope = this.provider.createScope();
    try {
      const db = scope.resolve(SearchDb);
      await db.transactionScope(async () => {
        const [row] = await db.database.querySqlRaw("SELECT pg_try_advisory_xact_lock({0}) AS locked", 42);
        if (row?.locked !== true) return;          // другой экземпляр уже работает
        await scope.resolve(SearchService).reindex(signal);
      });
    } finally {
      await scope.dispose();
    }
  }
}
```

`42` — номер блокировки, свой для каждой задачи. Проверено на двух
экземплярах: 13 запусков, ни одного пересечения по времени. И проверено,
что блокировку не держит упавший процесс: экземпляр, убитый `kill -9`
посреди работы, отдал её, и второй начал работу на следующем тике. Блокировка не
гарантирует, что задача выполнится один раз за период: следующий тик
другого экземпляра может начать её снова, как только закончилась
предыдущая. Для «один раз за период» — запись периода выше.

## Здоровье

Каждая фоновая служба модуля — отдельная проверка в `/health`:
`background:<Класс>`. Служба, которая остановилась насовсем — упала без
политики перезапуска или исчерпала `maxRestarts`, — делает весь ответ
`503`:

```text
GET /health  →  503
{"healthy":false,"checks":[
  {"name":"infra:db","healthy":true,…},
  {"name":"background:JobsWorker","healthy":true,…},
  {"name":"background:Crasher","healthy":false,…}]}
```

Оркестратор (Kubernetes, systemd с проверкой) увидит `503` и перезапустит
экземпляр. Без этого приложение продолжало бы принимать задачи, которые
никто не выполняет.

| Состояние службы | Проверка |
| --- | --- |
| Работает | `healthy: true` |
| Пауза перед перезапуском после падения | `healthy: true` |
| Тик периодической задачи упал | `healthy: true` — расписание продолжается |
| `execute` закончился без ошибки | `healthy: true` |
| Упала без перезапуска или исчерпала `maxRestarts` | `healthy: false` |

Причину показывает `http: { health: { exposeDetails: true } }`, с
маскировкой секретов:

```json
{"name":"background:Crasher","healthy":false,
 "details":"stopped after a crash and will not run again (no restart policy): cannot connect password=***"}
```

Служба, без которой приложение может работать (рассылка напоминаний,
сбор статистики), тоже попадает в `/health`. Чтобы её временный сбой не
выводил экземпляр из балансировки, дайте ей перезапуски с запасом —
`restart: { maxRestarts: 100, maxBackoffMs: 60_000 }`: пока перезапуски не
кончились, проверка зелёная, а каждое падение видно в журнале.

Своя служба (`HostedService`, не `BackgroundService`) сообщает состояние
методом `checkHealth(): { healthy, details? }`.

> [!NOTE]
> Проверки `background:<Класс>` — с версии 0.98.33. Раньше `/health`
> отвечал `200`, когда фоновая служба уже не работала.

> [!NOTE]
> С версии 0.98.33 службы объявляются только полем `background` модуля.
> Фабрика `backgroundModule({ services })` удалена.

## Дальше

- [Жизненный цикл](../fundamentals/lifecycle.md)
- [Транзакции](../database/transactions.md)
- [Немедленные изменения](../database/immediate.md)
- [Health checks](../fundamentals/health-checks.md)
