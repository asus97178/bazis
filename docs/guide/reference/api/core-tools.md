# `bazis/core/tools`

Готовые инструменты для процессов и агентов. Закрыты по умолчанию: приложение само называет,
что открыть. Список — по пакету 0.134.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `StandardToolsModule` | Необязательный модуль: владеет видами ссылок `orm.entity` и `orm.field` | [Данные без своего инструмента](../../workflow/processes.md#данные-без-своего-инструмента) |
| `ormEntityTools(Entity, { context, ops, fields, partitionField?, callers?, name?, maxRows?, maxChanges? })` | Инструменты `orm.<сущность>.find`, `create`, `update`, `delete` | [Данные без своего инструмента](../../workflow/processes.md#данные-без-своего-инструмента) |

Типы: `OrmEntityOperation`, `OrmEntityToolsOptions`.
