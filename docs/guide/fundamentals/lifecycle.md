# Жизненный цикл

Глава [Приложение](../overview/application.md) описывает запуск и остановку
снаружи: сигналы, тайм-ауты, коды выхода. Здесь — изнутри: фоновые службы,
хуки и порядок, в котором bazis их запускает и останавливает.

Все примеры проверены на bazis 0.97.10.

## Фоновые службы

Работа, которая идёт всё время жизни приложения — обработка очереди,
периодический отчёт, синхронизация, — оформляется фоновой службой и
подключается полем `background` модуля:

```ts
@Module({ providers: [...], background: [StatsReporter], exports: [] })
export class StatsModule {}
```

Ядро создаёт службу один раз (singleton, зависимости — через конструктор),
запускает её вместе с приложением и останавливает при выходе.

### Периодическая задача

«Делать X каждые N миллисекунд» — `PeriodicBackgroundService`:

```ts
import { Background, PeriodicBackgroundService } from "bazis/core/background";
import type { ServiceProvider } from "bazis/core/di";
import type { Logger } from "bazis/core/kernel";

@Background({ intervalMs: 60_000 })
export class StatsReporter extends PeriodicBackgroundService {
  constructor(private readonly provider: ServiceProvider, private readonly logger: Logger) {
    super();
  }

  protected override async tick(signal: AbortSignal): Promise<void> {
    const scope = this.provider.createScope();
    try {
      const count = await scope.resolve(ITaskService).count();
      if (!signal.aborted) this.logger.info(`tasks: ${count}`, { count });
    } finally {
      await scope.dispose();
    }
  }
}
```

- Тики не накладываются: следующий начинается через `intervalMs` после
  окончания предыдущего.
- Упавший тик не останавливает расписание — ошибка уходит в журнал, через
  интервал будет следующий тик.
- `runImmediately: false` — первый тик через интервал, а не сразу.

### Своя служба с циклом

Когда нужен свой цикл — например, чтение очереди, — наследуйте
`BackgroundService` и реализуйте `execute`:

```ts
import { BackgroundService, delay } from "bazis/core/background";

export class QueueWorker extends BackgroundService {
  constructor(private readonly queue: IQueue) { super(); }

  protected override async execute(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const job = await this.queue.take(signal);
      if (job) await this.handle(job);
      else await delay(1000, signal);
    }
  }
}
```

`start()` не ждёт окончания `execute`: служба работает в фоне и не держит
запуск приложения.

### Scoped-сервисы в фоновой службе

Фоновая служба — singleton, а `DbContext`, сервисы модулей и прочие
`scoped`-сервисы живут в области запроса. Внедрить их в конструктор
singleton нельзя — граф сервисов этого не пропустит. Внедрите
`ServiceProvider` и создавайте свою область на каждую единицу работы, как в
примере `StatsReporter` выше: `createScope()`, работа, `dispose()` в
`finally`. Так каждая единица работы получает свежий контекст базы данных, и
он закрывается, даже если работа упала.

### Отмена

При остановке приложения служба получает отменённый `signal`. Уважайте
его: проверяйте `signal.aborted` в цикле и ждите паузы через
`delay(ms, signal)` — такая пауза прерывается сразу.

Служба, которая сигнал не слушает, задерживает остановку. После
`stopTimeoutMs` (по умолчанию 5 секунд) bazis перестаёт её ждать и
останавливает остальное, но процесс не завершится, пока её работа не
закончится сама:

```text
warn: background Stubborn did not stop within 300ms: shutdown continues, but its unfinished work keeps the process alive until it ends
```

Ещё одна причина слушать `signal`: службы одной фазы останавливаются по
очереди, и медленная служба задерживает остановку соседних.

### Падения и перезапуск

Если `execute` бросил исключение, служба по умолчанию больше не работает.
Перезапуск включается политикой:

```ts
@Background({ restart: { maxRestarts: 3, backoffMs: 500 } })
export class QueueWorker extends BackgroundService { ... }
```

| Параметр | По умолчанию | Что задаёт |
| --- | --- | --- |
| `maxRestarts` | `0` | Сколько раз перезапустить после падения |
| `backoffMs` | `500` | Первая пауза перед перезапуском; дальше удваивается |
| `maxBackoffMs` | `30000` | Предел паузы |
| `onError` | — | Своя обработка падения вместо записи в журнал |

Каждое падение и окончание перезапусков видно в журнале приложения:

```text
error: background Crasher crashed {"service":"Crasher","restarts":0,"error":{...}}
error: background Crasher crashed {"service":"Crasher","restarts":1,"error":{...}}
error: background Crasher crashed {"service":"Crasher","restarts":2,"error":{...}}
error: background Crasher stopped after 2 restarts and will not run again {"service":"Crasher","restarts":2}
```

### Параметры службы

Задаются декоратором `@Background({...})` или в `super({...})` — явный
`super` важнее:

| Параметр | Для кого | Что задаёт |
| --- | --- | --- |
| `intervalMs` | Периодическая | Пауза между тиками; обязателен |
| `runImmediately` | Периодическая | Первый тик сразу (`true`) или через интервал |
| `stopTimeoutMs` | Все | Сколько ждать окончания при остановке; по умолчанию 5000 |
| `restart` | Все | Политика перезапуска |
| `phase` | Все | Фаза запуска, см. ниже |

## Хуки жизненного цикла

Хук — класс с любым набором методов, зарегистрированный под токеном
`LIFECYCLE_HOOK`:

```ts
import { LIFECYCLE_HOOK, type LifecycleHook } from "bazis/core/kernel";

export class WarmupHook implements LifecycleHook {
  onInit() { /* до запуска фоновых служб: прогреть кэш, проверить схему */ }
  onBootstrap() { /* все службы запущены */ }
  onShutdown(signal?: string) { /* службы уже остановлены */ }
  onDestroy() { /* последняя уборка перед освобождением контейнера */ }
}

@Module({ providers: [singleton(LIFECYCLE_HOOK, WarmupHook)], exports: [] })
```

Хуков может быть сколько угодно. Если хук упал в `onInit`, фоновые службы и
HTTP-сервер не запускаются, вызывается `onDestroy`, и приложение
завершается с кодом 1:

```text
hook: onInit
hook: onDestroy
[bazis] application failed: { name: 'Error', message: 'schema is not ready', ... }
```

Для коротких реакций есть `ApplicationLifetime`: `onStarted`, `onStopping`,
`onStopped`. Подписка на уже наступившее событие выполняется сразу (с
версии 0.97.2), так что подписываться можно и из сервиса, созданного на
первом запросе.

## Порядок запуска и остановки

Записано с приложения, где есть службы в фазах −1, 0 и 1, хук и подписки
`ApplicationLifetime`:

```text
hook: onInit
EarlyPhase (phase -1): start
Ticker, Crasher, Stubborn, Polite (phase 0): start     ← в порядке объявления в background
LatePhase (phase 1): start
hook: onBootstrap
lifetime: started
info: bazis started …

  … SIGTERM …

lifetime: stopping
LatePhase (phase 1): stop
Polite, Stubborn, Crasher, Ticker (phase 0): stop      ← в обратном порядке
EarlyPhase (phase -1): stop
hook: onShutdown (SIGTERM)
hook: onDestroy
lifetime: stopped
```

- Службы запускаются по возрастанию `phase` (по умолчанию 0), внутри фазы —
  в порядке объявления. Останавливаются в обратном порядке.
- Фаза пригодится, когда одна служба должна стартовать раньше остальных и
  остановиться позже — например, приём сообщений после подключения к
  брокеру.
- HTTP-сервер — тоже служба, фазы 10. Он запускается после ваших служб с
  фазой меньше 10 и останавливается первым: запросы начинают приниматься,
  когда фоновая работа уже идёт, и перестают — до её остановки.

## Дальше

- [Приложение](../overview/application.md)
- [DI подробно](dependency-injection.md)
- [События](events.md)
