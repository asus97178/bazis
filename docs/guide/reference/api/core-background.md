# `bazis/core/background`

Фоновые службы. Список — по пакету 0.111.2.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `BackgroundService` | Базовый класс долгой работы: свой цикл в `execute(signal)` | [Своя служба с циклом](../../fundamentals/lifecycle.md#своя-служба-с-циклом) |
| `PeriodicBackgroundService` | «Делать X каждые N мс»: метод `tick(signal)` | [Периодическая задача](../../fundamentals/lifecycle.md#периодическая-задача) |
| `Background(options)` | Декоратор класса с параметрами службы: `intervalMs`, `runImmediately`, перезапуск | [Параметры службы](../../fundamentals/lifecycle.md#параметры-службы) |
| `backgroundOptionsOf(Class)` | Прочитать параметры `@Background` | — |
| `delay(ms, signal)` | Пауза, которую прерывает отмена | [Отмена](../../fundamentals/lifecycle.md#отмена) |

Типы: `BackgroundServiceOptions`, `PeriodicBackgroundServiceOptions`,
`BackgroundDecoratorOptions`, `BackgroundRestartPolicy`.

Службу подключает поле `background` модуля
([Фоновые службы](../../realtime/background-services.md)).
