# `bazis/core/workflow`

Бизнес-процессы: составной модуль, сервисы, события, точки расширения.
Список — по пакету 0.128.0.

## Модули

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowModule` | Пак: каталог, исполнение и задачи | [Подключение](../../workflow/processes.md#подключение) |
| `WorkflowDefinitionsModule` | Часть «каталог процессов и версии»: таблицы `bazis_wf_def_*`, `/workflow/processes`, `/workflow/tools` | [Каталог и публикация](../../workflow/processes.md#каталог-и-публикация) |
| `WorkflowRuntimeModule` | Часть «исполнение»: таблицы `bazis_wf_run_*`, воркер, чистка, `/workflow/instances`, `/workflow/events` | [Запуск](../../workflow/processes.md#запуск) |
| `WorkflowTasksModule` | Часть «задачи сотрудникам»: таблица `bazis_wf_task_items`, `/workflow/tasks` | [Задача сотруднику](../../workflow/processes.md#задача-сотруднику) |

## Сервисы и настройки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `IWorkflowDefinitions` | Каталог: `list`, `get`, `create`, `update`, `saveDraft`, `publish`, `versions`, `version`, `latest`, `published`, `versionById`, `retentionPolicies`, `tools` | [Из кода](../../workflow/processes.md#из-кода) |
| `IWorkflowRuntime` | Исполнение: `start`, `emit`, `cancel`, `retry`, `completeToken`, `instances`, `instance`, `history` | [Из кода](../../workflow/processes.md#из-кода) |
| `IWorkflowTasks` | Входящие задачи: `list`, `get`, `claim`, `release`, `complete` | [Задача сотруднику](../../workflow/processes.md#задача-сотруднику) |
| `defineProcess({ key, title, description?, retentionDays?, document })` | Процесс в коде модуля: перечисляется в `@Module({ processes })`, публикуется при старте | [Процесс в коде](../../workflow/processes.md#процесс-в-коде) |
| `WorkflowSetupError` | Ошибка конфигурации процессов в коде: при сборке и при старте | [Процесс в коде](../../workflow/processes.md#процесс-в-коде) |
| `WorkflowClock`, `SystemWorkflowClock` | Часы движка (`now()`): сроки таймеров, повторов, расписания; по умолчанию системные | [Тесты процесса](../../workflow/processes.md#тесты-процесса) |
| `workflowRuntimeConfig` | Настройки `workflow.worker.*` и `workflow.retention.*` | [Несколько экземпляров](../../workflow/processes.md#несколько-экземпляров-приложения) |
| `WorkflowError` | Ошибка с `code` и HTTP-статусом | [Из кода](../../workflow/processes.md#из-кода) |

## Точки расширения

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowAccess` | Порт прав HTTP: `actor`, `can`, `assignees` | [Права](../../workflow/processes.md#права-workflowaccess) |
| `DenyWorkflowAccess` | Реализация «всё запрещено» | — |
| `WorkflowInputValidator`, `DefaultWorkflowInputValidator` | Проверка входа процесса и форм задач; встроенная — по полям документа | — |

## События

`WORKFLOW_TASK_REQUESTED`, `WORKFLOW_TOKEN_CLOSED` (`reason`: `cancelled`, `interrupted`),
`WORKFLOW_INSTANCE_FINISHED`, `WORKFLOW_INSTANCES_DELETED` (чистка удалила
экземпляры) ([Задача сотруднику](../../workflow/processes.md#задача-сотруднику)).

## Типы

- **Процессы в коде:** `ProcessDefinition`, `CodeProcess`; поле `processes`
  в метаданных `@Module`.
- **Каталог:** `ProcessSummary` (с `module` — модулем-владельцем процесса из кода), `ProcessDetails`, `VersionSummary`,
  `VersionDetails`, `CreateProcess`, `UpdateProcess`, `ProcessListQuery`.
- **Исполнение:** `StartInstance`, `EmitOptions`, `EmitResult`, `InstanceSummary`, `InstanceDetails`,
  `TokenDetails`, `HistoryEntry`, `InstanceListQuery`, `InstanceStatus`,
  `TokenStatus`, `StartedVia`, `HistoryType`.
- **Задачи:** `TaskDetails`, `TaskListQuery`, `TaskStatus`.
- **События:** `WorkflowTaskRequested`, `WorkflowTokenClosed`,
  `WorkflowInstanceFinished`, `WorkflowInstancesDeleted`.
- **Прочее:** `WorkflowActor`, `WorkflowPage`, `WorkflowPaging`,
  `WorkflowAction`, `WorkflowAccessTarget`, `WorkflowInputContext`,
  `WorkflowErrorCode`.
