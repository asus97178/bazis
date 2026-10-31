# `bazis/core/workflow/testing`

Тесты бизнес-процессов. Список — по пакету 0.128.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `testWorkflow(AppModule, options)` | Запускает приложение как `startTestApp`, с часами теста и без фонового воркера: `start`, `emit`, `complete`, `drain`, `advance`, `instance`, `history`, `now`, `clock`, `app`, `stop` | [Тесты процесса](../../workflow/processes.md#тесты-процесса) |
| `ManualWorkflowClock` | Часы, которые стоят, пока их не сдвинут: `advance(duration)`, `set(date)`, только вперёд | там же |
| `TestWorkflow`, `TestWorkflowOptions` | Типы: запущенное приложение с процессами и его опции (опции `startTestApp` плюс `now`, `actor`) | там же |
