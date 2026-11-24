# `bazis/library/jsonapi`

Списки в стиле JSON:API: модель списка, разбор параметров, документ
ответа. Те же модели и функции экспортирует
[`bazis/core/http`](core-http.md#списки). Список — по пакету 0.143.0.

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `ListRequest`, `ListOptions`, `Sortable`, `Filterable` | Модель списка: что можно сортировать и фильтровать, пределы страниц | [Модель списка](../../module/controllers/lists.md#модель-списка) |
| `parseListQuery(params, options)` | Разбор `sort`, `filter[…]`, `page[…]`, `include`, `fields` по разрешённому | [Параметры запроса](../../module/controllers/lists.md#параметры-запроса) |
| `optionsFromSchema(Class)`, `listSchemaOf(Class)` | Разрешённое модели списка | — |
| `restrictListOptions(options, fields)` | Разрешённое только для открытых полей: фильтр и сортировка по закрытому полю дают `400` | [Поля в списке](../../module/access.md#поля-в-списке) |
| `buildListDocument(items, query, total, options)` | Документ ответа: `data`, `meta`, `links` | [Ответ](../../module/controllers/lists.md#ответ) |
| `serializeListQuery(query)` | Строка запроса из `ListQuery` | — |
| `ListQueryError` | Ошибка разбора; в HTTP — `400` со списком проблем | [Ошибки](../../module/controllers/lists.md#ошибки) |

Типы: `ListQuery`, `ListQueryOptions`, `ListQueryProblem`, `ListSchema`,
`FieldSchema`, `ListOptionsConfig`, `PageOptions`, `PageParams`,
`SortField`, `SortDirection`, `FilterRule`, `FilterGroup`,
`FilterOperator`, `ListDocument`, `ListLinks`, `ListMeta`,
`BuildListDocumentOptions`.
