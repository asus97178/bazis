# `bazis/library/workflow`

Формат документа процесса `bazis.workflow/v2`: чистые функции без DI и
базы — для дизайнера, CLI, браузера. Список — по пакету 0.133.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `PROCESS_SCHEMA_VERSION`, `emptyProcess()` | Версия формата; новый процесс «старт → конец» | [Документ процесса](../../workflow/processes.md#документ-процесса) |
| `inputSpecOf`, `initialVarsOf`, `outputOf` | Поля входа, начальные `$vars`, что отдаёт завершённый процесс | [Переменные](../../workflow/processes.md#переменные) |
| `upgradeDocument`, `upgradeCondition`, `PROCESS_SCHEMA_VERSION_V1` | Документ и условие версии 1 как версия 2 | [Обновление](../upgrading.md#01320) |
| `validateProcess(document, { tools, processes, extensions })`, `hasErrors`, `PROCESS_LIMITS` | Проверка документа: все замечания сразу; есть ли среди них ошибки; пределы размера | [Каталог и публикация](../../workflow/processes.md#каталог-и-публикация) |
| `NODE_KINDS`, `nodeKindOf`, `ISO_DURATION` | Виды узлов и их роли в графе; длительность ISO 8601 | — |
| `DATA_PATH`, `DATA_PATHS`, `isPath`, `readPath`, `resolveInput` | Пути `$input`, `$vars`, `$nodes`, `$event`, `$trigger`, `$run`, `$now`, `$item`, `$index`; подстановка во вход шага | [Выражения](../../workflow/processes.md#выражения) |
| `evaluateExpression`, `isTruthy`, `checkExpression`, `checkPath`, `isExpressionNode`, `expressionFunction`, `EXPRESSION_FUNCTIONS`, `EXPRESSION_LIMITS` | Выражения: значение, проверка, список функций | [Выражения](../../workflow/processes.md#выражения) |
| `parseExpression`, `printExpression`, `ExpressionSyntaxError` | Текст выражения ↔ дерево | [Свой дизайнер](../../workflow/processes.md#свой-дизайнер) |
| `toStructure`, `fromStructure`, `isStructured` | Граф ↔ список шагов | [Свой дизайнер](../../workflow/processes.md#свой-дизайнер) |
| `processPalette`, `formOf` | Палитра; форма настройки шага | [Свой дизайнер](../../workflow/processes.md#свой-дизайнер) |
| `textOf`, `allTexts`, `checkLocalizedText` | Текст на нужном языке | [Карточка и язык](../../workflow/processes.md#карточка-и-язык) |
| `checkFormSpec`, `variableProblems`, `checkExtensions`, `formFieldNames`, `validateForm`, `FIELD_NAME` | Поля и переменные, проверка значения | [Переменные](../../workflow/processes.md#переменные) |
| `masksPersonal`, `personalPaths`, `personalVariables`, `readsPersonal`, `maskByMapping`, `maskBySchema`, `PERSONAL_MASK` | Маска персональных данных | [Настройки процесса и журнал](../../workflow/processes.md#настройки-процесса-и-журнал) |
| `durationMs` | Миллисекунды длительности `P1D`, `PT2H` | — |
| `processToMermaid(document, direction?)` | Процесс как Mermaid `flowchart` | [Проверка и схема](../../workflow/processes.md#проверка-и-схема-bazis-workflow) |
| `parseCron` | Разбор cron из пяти полей в UTC: `matches(date)`, `next(after)` | [Расписание](../../workflow/processes.md#расписание) |

Типы: `ProcessDocument`, `ProcessNode`, `ProcessFlow`, `ProcessDiagram`,
`ProcessSettings`, `ProcessLogSettings`, `Bounds`, `Point`, `NodeKind`, `NodeRole`,
`NodeKindDefinition`, `JsonSchema`, `ProcessIssue`, `ProcessIssueCode`,
`ValidateProcessOptions`, `InstanceData`, `Expr`, `ExprCall`, `ExprPath`, `ExprType`,
`ExprFunction`, `ExprFunctionName`, `ExpressionScope`, `LocalizedText`, `FormSpec`,
`FormField`, `VariableSpec`, `VariableDirection`, `FieldType`, `FormIssue`,
`ProcessDocumentV1`, `ConditionV1`, `FormFieldV1`, `ProcessStructure`, `StructureStep`,
`StructureBranch`, `StructureBoundary`, `StructureStart`, `ProcessPalette`,
`PaletteNodeKind`, `PaletteTool`, `StepForm`, `StepFormField`, `CronSchedule`.
