# `bazis/core/tools`

Готовые инструменты для процессов и агентов. Закрыты по умолчанию: приложение само называет,
что открыть. Список — по пакету 0.136.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `StandardToolsModule` | Необязательный модуль: `http.request`, значения `$secrets`, виды ссылок `orm.entity` и `orm.field` | [HTTP-запрос и секреты](../../workflow/processes.md#http-запрос-и-секреты) |
| `HttpRequestTool` | Шаг `http.request`; настройки `tools.http.*` | [HTTP-запрос и секреты](../../workflow/processes.md#http-запрос-и-секреты) |
| `SecretStore`, `ConfigSecretStore` | Значения `$secrets.NAME`: `get(name, { partition })`; по умолчанию из конфигурации `secrets.*` | [Секреты](../../workflow/processes.md#секреты) |
| `toolsConfig` | Настройки `tools.http.allow`, `callers`, `allowPrivateNetworks`, `maxResponseBytes`, `timeoutMs` | [HTTP-запрос и секреты](../../workflow/processes.md#http-запрос-и-секреты) |
| `ormEntityTools(Entity, { context, ops, fields, partitionField?, callers?, name?, maxRows?, maxChanges? })` | Инструменты `orm.<сущность>.find`, `create`, `update`, `delete` | [Данные без своего инструмента](../../workflow/processes.md#данные-без-своего-инструмента) |

Типы: `OrmEntityOperation`, `OrmEntityToolsOptions`, `SecretContext`, `ToolsSettings`.
