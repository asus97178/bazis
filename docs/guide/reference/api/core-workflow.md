# `bazis/core/workflow`

Бизнес-процессы: составной модуль, сервисы, события, точки расширения.
Список — по пакету 0.142.0.

## Модули

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowModule` | Пак: каталог, исполнение и задачи | [Подключение](../../module/processes.md#подключение) |
| `WorkflowDefinitionsModule` | Часть «каталог процессов и версии»: таблицы `bazis_wf2_def_*`, `/workflow/processes`, `/workflow/tools`, `/workflow/palette`, `/workflow/validate` | [Каталог и публикация](../../module/processes.md#каталог-и-публикация) |
| `WorkflowRuntimeModule` | Часть «исполнение»: таблицы `bazis_wf2_run_*`, воркер, чистка, `/workflow/instances`, `/workflow/events` | [Запуск](../../module/processes.md#запуск) |
| `WorkflowTasksModule` | Часть «задачи сотрудникам»: таблица `bazis_wf2_task_items`, `/workflow/tasks` | [Задача сотруднику](../../module/processes.md#задача-сотруднику) |

## Сервисы и настройки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `IWorkflowDefinitions` | Каталог: `list`, `get`, `folderOf`, `partitionsOf`, `validate`, `palette`, `create`, `update`, `remove`, `saveDraft`, `publish`, `versions`, `version`, `latest`, `published`, `versionById`, `referencing`, `retentionPolicies`, `tools` | [Из кода](../../module/processes.md#из-кода) |
| `IWorkflowRuntime` | Исполнение: `start`, `startMany`, `emit`, `emitLater`, `cancel`, `retry`, `completeToken`, `instances`, `instance`, `history` | [Из кода](../../module/processes.md#из-кода) |
| `IWorkflowTasks` | Входящие задачи: `list`, `get`, `claim`, `release`, `complete` | [Задача сотруднику](../../module/processes.md#задача-сотруднику) |
| `defineProcess({ key, title, description?, folder?, owner?, retentionDays?, document })` | Процесс в коде модуля: перечисляется в `@Module({ processes })`, публикуется при старте. Документ-литерал проверяется при сборке; инструмент и процесс называют ссылкой (с 0.138.0) | [Процесс в коде](../../module/processes.md#процесс-в-коде) |
| `WorkflowSetupError` | Ошибка конфигурации процессов в коде: при сборке и при старте | [Процесс в коде](../../module/processes.md#процесс-в-коде) |
| `WorkflowClock`, `SystemWorkflowClock` | Часы движка (`now()`): сроки таймеров, повторов, расписания; по умолчанию системные | [Тесты процесса](../../module/processes.md#тесты-процесса) |
| `workflowConfig` | Настройки `workflow.language`, `workflow.languages`, `workflow.worker.*` и `workflow.retention.*` | [Несколько экземпляров](../../module/processes.md#несколько-экземпляров-приложения) |
| `WorkflowError` | Ошибка с `code` и HTTP-статусом | [Из кода](../../module/processes.md#из-кода) |

## Права

Права `workflow.*` и виды ссылок `workflow.process`, `workflow.folder` объявляет сам модуль, а
система прав — общая: `AccessPolicy` из [`bazis/core/access`](core-access.md).
Подробно — [Права](../../module/processes.md#права).

## Точки расширения

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowInputValidator`, `DefaultWorkflowInputValidator` | Проверка входа процесса и форм задач; встроенная — по полям документа | [Данные приложения](../../module/processes.md#данные-приложения) |
| `WorkflowExtensions`, `DefaultWorkflowExtensions` | Проверка `extensions` своего пространства имён; по умолчанию пространств нет | [Данные приложения](../../module/processes.md#данные-приложения) |
| `WorkflowPartitions`, `DefaultWorkflowPartitions` | Где работает процесс: разделы с часовым поясом и включённостью; по умолчанию один раздел `null` | [Разделы](../../module/processes.md#разделы) |

## События

`WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED` (`reason`: `cancelled`, `interrupted`, `timedOut`),
`WORKFLOW_INSTANCE_FINISHED` (`status`: `completed`, `cancelled`, `timedOut`), `WORKFLOW_INSTANCES_DELETED` (чистка удалила
экземпляры) ([Задача сотруднику](../../module/processes.md#задача-сотруднику)).

Для аудита: `WORKFLOW_PROCESS_CHANGED`, `WORKFLOW_INSTANCE_STARTED`,
`WORKFLOW_INSTANCE_CANCELLED`, `WORKFLOW_INSTANCE_RETRIED`,
`WORKFLOW_TASK_COMPLETED` ([Журнал аудита](../../module/processes.md#журнал-аудита)).

## Типы

- **Процессы в коде:** `ProcessDefinition`, `CodeProcess<Input, Output>`, `CodeProcessDocument`,
  `CodeProcessNode`, `CodeProcessSettings`, `CodeNodeConfigs`, `ProcessInput`, `ProcessOutput`,
  `ToolRef`, `ToolClass`, `ProcessRef`; поле `processes` в метаданных `@Module`.
- **Каталог:** `ProcessSummary` (с `module` — модулем-владельцем процесса из кода), `ProcessDetails`, `VersionSummary`,
  `VersionDetails`, `CreateProcess`, `UpdateProcess`, `ProcessListQuery`, `ValidateOptions`, `ProcessReference`, `ProcessReferenceQuery`.
- **Исполнение:** `StartInstance`, `StartMany`, `StartManyItem`, `StartManyResult`, `EmitCause`, `EmitOptions`, `EmitResult`, `InstanceSummary`, `InstanceDetails`,
  `TokenDetails`, `HistoryEntry`, `InstanceListQuery`, `InstanceStatus`,
  `TokenStatus`, `StartedVia`, `HistoryType`.
- **Задачи:** `TaskDetails`, `TaskListQuery`, `TaskStatus`.
- **События:** `WorkflowTaskRequested`, `WorkflowTokenClosed`,
  `WorkflowInstanceFinished`, `WorkflowInstancesDeleted`.
- **Прочее:** `WorkflowActor`, `WorkflowPage`, `WorkflowPaging`,
  `WorkflowInputContext`, `WorkflowPortContext`, `ExtensionTarget`, `WorkflowSettings`,
  `WorkflowErrorCode`.
