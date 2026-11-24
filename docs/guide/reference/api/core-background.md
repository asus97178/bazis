# `bazis/core/background`

Фоновые службы. Список — по пакету 0.128.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `BackgroundService` | Базовый класс долгой работы: свой цикл в `execute(signal)` | [Своя служба с циклом](../../startup/lifecycle.md#своя-служба-с-циклом) |
| `PeriodicBackgroundService` | «Делать X каждые N мс»: метод `tick(signal)` | [Периодическая задача](../../startup/lifecycle.md#периодическая-задача) |
| `Background(options)` | Декоратор класса с параметрами службы: `intervalMs`, `runImmediately`, перезапуск | [Параметры службы](../../startup/lifecycle.md#параметры-службы) |
| `backgroundOptionsOf(Class)` | Прочитать параметры `@Background` | — |
| `delay(ms, signal)` | Пауза, которую прерывает отмена | [Отмена](../../startup/lifecycle.md#отмена) |

Типы: `BackgroundServiceOptions`, `PeriodicBackgroundServiceOptions`,
`BackgroundDecoratorOptions`, `BackgroundRestartPolicy`.

Службу подключает поле `background` модуля
([Фоновые службы](../../module/background-services.md)).
