# События

События развязывают модули: модуль заказов сообщает «заказ создан» и не
знает, кто на это реагирует — статистика, аудит, уведомления. Шина событий
в bazis работает внутри процесса и строится на DI.

Все примеры проверены на bazis 0.97.10.

## Событие

Событие — типизированный токен. Тип полезной нагрузки задаётся в угловых
скобках:

```ts
import { createEventToken } from "bazis/core/kernel";

export interface OrderCreated { readonly id: string; readonly amount: number; }
export const ORDER_CREATED = createEventToken<OrderCreated>("orders.created");
```

Токен объявляет модуль-источник события; подписчики импортируют его как
обычный TypeScript-экспорт.

## Публикация

Сервис получает `EventBus` через конструктор:

```ts
import { EventBus } from "bazis/core/kernel";

export class OrderService {
  constructor(private readonly events: EventBus) {}

  async create(ctx: HttpContext, amount: number) {
    const order = { id: crypto.randomUUID(), amount };
    await this.events.publishScoped(ctx.services, ORDER_CREATED, order);
    return order;
  }
}
```

| Метод | Когда |
| --- | --- |
| `publishScoped(scope, EVENT, payload)` | В запросе или в своей области (`ctx.services`, `provider.createScope()`): подписчики могут быть `scoped` |
| `publish(EVENT, payload)` | Вне запроса, когда все подписчики — функции или `singleton` |

`publish` разрешает подписчиков из корня контейнера, поэтому
`scoped`-подписчик там не сработает:

```text
ScopedServiceFromRootError: Cannot resolve scoped service "AuditTrail" from root provider.
```

`await` ждёт, пока отработают **все** обработчики, — они выполняются по
очереди, в том же запросе. Медленный обработчик замедляет ответ.

## Подписка

### Функцией

Простой обработчик — прямо в `providers` модуля:

```ts
import { onEvent } from "bazis/core/kernel";

@Module({
  providers: [
    onEvent(ORDER_CREATED, (order) => console.log(`order ${order.id}`)),
  ],
  exports: [],
})
export class NotificationsModule {}
```

### Методом класса

Когда обработчику нужны сервисы или состояние, — метод класса с
`@OnEvent`:

```ts
import { OnEvent } from "bazis/core/kernel";

export class OrderStats {
  total = 0;

  @OnEvent(ORDER_CREATED)
  onCreated(order: OrderCreated) {
    this.total += order.amount;
  }
}
```

Класс-подписчик подключается одним из двух способов:

| Как | Время жизни подписчика |
| --- | --- |
| `imports: [eventsModule({ subscribers: [OrderStats] })]` | `singleton`: один экземпляр на приложение, состояние копится |
| `providers: [scoped(AuditTrail), ...withEventSubscribers(AuditTrail)]` | Какое объявите. `scoped` получает сервисы текущего запроса |

Проверено: `scoped`-подписчик, опубликованный через
`publishScoped(ctx.services, ...)`, получает ту же область, что и
контроллер, — тот же экземпляр `scoped`-сервиса.

## Порядок

Обработчики выполняются по `order` — меньше раньше, по умолчанию 0; при
равенстве — в порядке регистрации:

```ts
@OnEvent(ORDER_CREATED, { order: -1 })          // аудит — первым
onEvent(ORDER_CREATED, handler, { order: 1 })   // уведомление — последним
```

```text
audit: order o50 in request 7ti7
stats: +50 = 50
notify: order o50
```

## Ошибки

По умолчанию упавший обработчик не останавливает остальных: отрабатывают
все, а потом `publish` бросает ошибку (если упало несколько —
`AggregateError`). В HTTP-запросе это `500`, хотя аудит и статистика уже
записаны.

Если сбой подписчика не должен ломать того, кто публикует, —
`isolate`:

```ts
await this.events.publishScoped(ctx.services, ORDER_CREATED, order, {
  isolate: true,
  onError: (error, { event }) => logger.error(`handler of ${event.name} failed`, { error }),
});
```

| Опция | Что делает |
| --- | --- |
| `isolate: true` | Ошибки обработчиков не бросаются из `publish` |
| `onError(error, { event, payload })` | Вызывается на каждую ошибку обработчика |
| `handlerTimeoutMs` | Обработчик дольше — ошибка `EventHandlerTimeoutError` |
| `signal` | Отмена: оставшиеся обработчики не выполняются |

```text
EventHandlerTimeoutError: Event "orders.created" handler exceeded 50ms.
```

## События приложения

bazis сам публикует два события — на них можно подписаться как на любые
другие:

| Событие | Когда | Данные |
| --- | --- | --- |
| `APPLICATION_STARTED` | Приложение запущено | `environment`, `startupMs` |
| `APPLICATION_STOPPING` | Началась остановка | `signal`, `exitCode` |

```ts
@OnEvent(APPLICATION_STARTED)
onStarted(event: ApplicationStartedEvent) {
  console.log(`started in ${event.environment}`);
}
```

## Чего шина не делает

- **Не передаёт события между процессами.** Если приложение запущено в
  нескольких экземплярах, событие получат только подписчики того же
  процесса.
- **Не хранит события.** Если процесс упал во время публикации, событие
  потеряно. Для надёжной доставки нужна очередь или таблица исходящих
  событий в той же транзакции, что и данные.

## Дальше

- [Жизненный цикл](lifecycle.md)
- [DI подробно](dependency-injection.md)
- [Логирование и correlation id](logging.md)
