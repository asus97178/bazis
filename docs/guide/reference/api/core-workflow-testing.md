# `bazis/core/workflow/testing`

Тесты бизнес-процессов. Список — по пакету 0.140.1.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `testWorkflow(Application, options)` | Запускает приложение как `startTestApp`, с часами теста и без фонового воркера: `start` (процесс ключом или самим `defineProcess`), `emit`, `complete`, `drain`, `advance`, `instance`, `instanceByKey`, `history`, `use`, `now`, `clock`, `app`, `stop` | [Тесты процесса](../../workflow/processes.md#тесты-процесса) |
| `dropWorkflowTables(url, { force? })` | Удаляет таблицы процессов в тестовой базе: следующий запуск создаст их заново. Имя базы должно начинаться с `test_` или кончаться на `_test`, иначе нужен `force: true`. С версии 0.138.0 | там же |
| `ManualWorkflowClock` | Часы, которые стоят, пока их не сдвинут: `advance(duration)`, `set(date)`, только вперёд | там же |
| `TestWorkflow`, `TestWorkflowOptions` | Типы: запущенное приложение с процессами и его опции (опции `startTestApp` плюс `now`, `actor`) | там же |
