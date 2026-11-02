# `bazis/core/workflow`

Бизнес-процессы: составной модуль, сервисы, события, точки расширения.
Список — по пакету 0.133.0.

## Модули

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowModule` | Пак: каталог, исполнение и задачи | [Подключение](../../workflow/processes.md#подключение) |
| `WorkflowDefinitionsModule` | Часть «каталог процессов и версии»: таблицы `bazis_wf2_def_*`, `/workflow/processes`, `/workflow/tools`, `/workflow/palette`, `/workflow/validate` | [Каталог и публикация](../../workflow/processes.md#каталог-и-публикация) |
| `WorkflowRuntimeModule` | Часть «исполнение»: таблицы `bazis_wf2_run_*`, воркер, чистка, `/workflow/instances`, `/workflow/events` | [Запуск](../../workflow/processes.md#запуск) |
| `WorkflowTasksModule` | Часть «задачи сотрудникам»: таблица `bazis_wf2_task_items`, `/workflow/tasks` | [Задача сотруднику](../../workflow/processes.md#задача-сотруднику) |

## Сервисы и настройки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `IWorkflowDefinitions` | Каталог: `list`, `get`, `folderOf`, `validate`, `palette`, `create`, `update`, `saveDraft`, `publish`, `versions`, `version`, `latest`, `published`, `versionById`, `retentionPolicies`, `tools` | [Из кода](../../workflow/processes.md#из-кода) |
| `IWorkflowRuntime` | Исполнение: `start`, `startMany`, `emit`, `cancel`, `retry`, `completeToken`, `instances`, `instance`, `history` | [Из кода](../../workflow/processes.md#из-кода) |
| `IWorkflowTasks` | Входящие задачи: `list`, `get`, `claim`, `release`, `complete` | [Задача сотруднику](../../workflow/processes.md#задача-сотруднику) |
| `defineProcess({ key, title, description?, folder?, owner?, retentionDays?, document })` | Процесс в коде модуля: перечисляется в `@Module({ processes })`, публикуется при старте | [Процесс в коде](../../workflow/processes.md#процесс-в-коде) |
| `WorkflowSetupError` | Ошибка конфигурации процессов в коде: при сборке и при старте | [Процесс в коде](../../workflow/processes.md#процесс-в-коде) |
| `WorkflowClock`, `SystemWorkflowClock` | Часы движка (`now()`): сроки таймеров, повторов, расписания; по умолчанию системные | [Тесты процесса](../../workflow/processes.md#тесты-процесса) |
| `workflowConfig` | Настройки `workflow.language`, `workflow.languages`, `workflow.worker.*` и `workflow.retention.*` | [Несколько экземпляров](../../workflow/processes.md#несколько-экземпляров-приложения) |
| `WorkflowError` | Ошибка с `code` и HTTP-статусом | [Из кода](../../workflow/processes.md#из-кода) |

## Права

Права `workflow.*` и виды ссылок `workflow.process`, `workflow.folder` объявляет сам модуль, а
система прав — общая: `AccessPolicy` из [`bazis/core/access`](core-access.md).
Подробно — [Права](../../workflow/processes.md#права).

## Точки расширения

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowInputValidator`, `DefaultWorkflowInputValidator` | Проверка входа процесса и форм задач; встроенная — по полям документа | [Данные приложения](../../workflow/processes.md#данные-приложения) |
| `WorkflowExtensions`, `DefaultWorkflowExtensions` | Проверка `extensions` своего пространства имён; по умолчанию пространств нет | [Данные приложения](../../workflow/processes.md#данные-приложения) |

## События

`WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED` (`reason`: `cancelled`, `interrupted`, `timedOut`),
`WORKFLOW_INSTANCE_FINISHED` (`status`: `completed`, `cancelled`, `timedOut`), `WORKFLOW_INSTANCES_DELETED` (чистка удалила
экземпляры) ([Задача сотруднику](../../workflow/processes.md#задача-сотруднику)).

Для аудита: `WORKFLOW_PROCESS_CHANGED`, `WORKFLOW_INSTANCE_STARTED`,
`WORKFLOW_INSTANCE_CANCELLED`, `WORKFLOW_INSTANCE_RETRIED`,
`WORKFLOW_TASK_COMPLETED` ([Журнал аудита](../../workflow/processes.md#журнал-аудита)).

## Типы

- **Процессы в коде:** `ProcessDefinition`, `CodeProcess`; поле `processes`
  в метаданных `@Module`.
- **Каталог:** `ProcessSummary` (с `module` — модулем-владельцем процесса из кода), `ProcessDetails`, `VersionSummary`,
  `VersionDetails`, `CreateProcess`, `UpdateProcess`, `ProcessListQuery`, `ValidateOptions`.
- **Исполнение:** `StartInstance`, `StartMany`, `StartManyItem`, `StartManyResult`, `EmitOptions`, `EmitResult`, `InstanceSummary`, `InstanceDetails`,
  `TokenDetails`, `HistoryEntry`, `InstanceListQuery`, `InstanceStatus`,
  `TokenStatus`, `StartedVia`, `HistoryType`.
- **Задачи:** `TaskDetails`, `TaskListQuery`, `TaskStatus`.
- **События:** `WorkflowTaskRequested`, `WorkflowTokenClosed`,
  `WorkflowInstanceFinished`, `WorkflowInstancesDeleted`.
- **Прочее:** `WorkflowActor`, `WorkflowPage`, `WorkflowPaging`,
  `WorkflowInputContext`, `WorkflowPortContext`, `ExtensionTarget`, `WorkflowSettings`,
  `WorkflowErrorCode`.
