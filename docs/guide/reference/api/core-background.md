# `bazis/core/background`

Фоновые службы. Список — по пакету 0.128.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `BackgroundService` | Базовый класс долгой работы: свой цикл в `execute(signal)` | [Своя служба с циклом](../../application/lifecycle.md#своя-служба-с-циклом) |
| `PeriodicBackgroundService` | «Делать X каждые N мс»: метод `tick(signal)` | [Периодическая задача](../../application/lifecycle.md#периодическая-задача) |
| `Background(options)` | Декоратор класса с параметрами службы: `intervalMs`, `runImmediately`, перезапуск | [Параметры службы](../../application/lifecycle.md#параметры-службы) |
| `backgroundOptionsOf(Class)` | Прочитать параметры `@Background` | — |
| `delay(ms, signal)` | Пауза, которую прерывает отмена | [Отмена](../../application/lifecycle.md#отмена) |

Типы: `BackgroundServiceOptions`, `PeriodicBackgroundServiceOptions`,
`BackgroundDecoratorOptions`, `BackgroundRestartPolicy`.

Службу подключает поле `background` модуля
([Фоновые службы](../../module/background-services.md)).
