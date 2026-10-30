# `bazis/library/workflow`

Формат документа процесса `bazis.workflow/v1`: чистые функции без DI и
базы — для дизайнера, CLI, браузера. Список — по пакету 0.124.1.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `PROCESS_SCHEMA_VERSION`, `emptyProcess()` | Версия формата; новый процесс «старт → конец» | [Документ процесса](../../workflow/processes.md#документ-процесса) |
| `validateProcess(document, { tools })`, `hasErrors`, `PROCESS_LIMITS` | Проверка документа: все замечания сразу; есть ли среди них ошибки; пределы размера | [Каталог и публикация](../../workflow/processes.md#каталог-и-публикация) |
| `NODE_KINDS`, `nodeKindOf`, `ISO_DURATION` | Виды узлов и их роли в графе; длительность ISO 8601 | — |
| `DATA_PATH`, `isPath`, `readPath`, `resolveInput` | Пути `$input` / `$vars` / `$nodes`; подстановка во вход шага | [Документ процесса](../../workflow/processes.md#документ-процесса) |
| `evaluateCondition` | Условие перехода | — |
| `checkFormSpec`, `formFieldCodes`, `validateForm` | Поля входа и форм, проверка значения | — |
| `durationMs` | Миллисекунды длительности `P1D`, `PT2H` | — |

Типы: `ProcessDocument`, `ProcessNode`, `ProcessFlow`, `ProcessDiagram`,
`Bounds`, `Point`, `NodeKind`, `NodeRole`, `NodeKindDefinition`,
`Condition`, `ConditionOp`, `ProcessIssue`, `ProcessIssueCode`,
`ValidateProcessOptions`, `InstanceData`, `FormSpec`, `FormField`,
`FormFieldType`, `FormIssue`.
