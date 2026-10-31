# `bazis/core/workflow`

Бизнес-процессы: составной модуль, сервисы, события, точки расширения.
Список — по пакету 0.126.0.

## Модули

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `WorkflowModule` | Пак: каталог и исполнение | [Подключение](../../workflow/processes.md#подключение) |
| `WorkflowDefinitionsModule` | Часть «каталог процессов и версии»: таблицы `bazis_wf_def_*`, `/workflow/processes`, `/workflow/tools` | [Каталог и публикация](../../workflow/processes.md#каталог-и-публикация) |
| `WorkflowRuntimeModule` | Часть «исполнение»: таблицы `bazis_wf_run_*`, воркер, чистка, `/workflow/instances` | [Запуск](../../workflow/processes.md#запуск) |

## Сервисы и настройки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `IWorkflowDefinitions` | Каталог: `list`, `get`, `create`, `update`, `saveDraft`, `publish`, `versions`, `version`, `latest`, `published`, `versionById`, `retentionPolicies`, `tools` | [Из кода](../../workflow/processes.md#из-кода) |
| `IWorkflowRuntime` | Исполнение: `start`, `emit`, `cancel`, `retry`, `completeToken`, `instances`, `instance`, `history` | [Из кода](../../workflow/processes.md#из-кода) |
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
`WORKFLOW_INSTANCE_FINISHED` ([Задача сотруднику](../../workflow/processes.md#задача-сотруднику)).

## Типы

- **Каталог:** `ProcessSummary`, `ProcessDetails`, `VersionSummary`,
  `VersionDetails`, `CreateProcess`, `UpdateProcess`, `ProcessListQuery`.
- **Исполнение:** `StartInstance`, `EmitOptions`, `EmitResult`, `InstanceSummary`, `InstanceDetails`,
  `TokenDetails`, `HistoryEntry`, `InstanceListQuery`, `InstanceStatus`,
  `TokenStatus`, `StartedVia`, `HistoryType`.
- **События:** `WorkflowTaskRequested`, `WorkflowTokenClosed`,
  `WorkflowInstanceFinished`.
- **Прочее:** `WorkflowActor`, `WorkflowPage`, `WorkflowPaging`,
  `WorkflowAction`, `WorkflowAccessTarget`, `WorkflowInputContext`,
  `WorkflowErrorCode`.
