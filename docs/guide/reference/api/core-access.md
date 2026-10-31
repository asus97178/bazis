# `bazis/core/access`

Права модулей: каталог permissions, проверки и фильтры списков по грантам
системы прав приложения. Список — по пакету 0.129.0.

## Модуль и объявления

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `AccessModule` | Подключается один раз: каталог, `Access`, роли по умолчанию, `/access/catalog`, `/access/references/:kind` | [Объявить права](../../security/access.md#объявить-права) |
| `definePermissions({...})` | Права модуля для `@Module({ permissions })`: `title`, `description`, `scope`, `on`, `owner`, `fields` | [Объявить права](../../security/access.md#объявить-права) |
| `defineRoles({...})` | Роли системы прав по умолчанию для `@Module({ roles })`; `"<право>:own"` — только своё | [Роли по умолчанию](../../security/access.md#роли-по-умолчанию) |
| `References` | Значения вида ссылки для `@Module({ references })`: `exists`, `describe`, `search` | [Ссылки и каталог](../../security/access.md#ссылки-и-каталог-для-админки) |
| `AttributeLookup` | Атрибут или раздел, которого нет в колонках строки: `toColumn(values)` → `{ column, in }` | [Объявить права](../../security/access.md#объявить-права) |
| `AccessCatalog` | Права, виды ссылок и роли всех модулей приложения | — |
| `accessConfig` | Настройки `access.kindClaim`, `access.roleClaim`, `access.maxInList` | [Роли по умолчанию](../../security/access.md#роли-по-умолчанию) |
| `AccessSetupError` | Ошибка объявлений при сборке приложения | [Объявить права](../../security/access.md#объявить-права) |

## Проверки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `can(permission, objectOf?)` | Проверка маршрута: `401` без человека, `403` без права; без объекта — право хоть где-нибудь | [Проверить маршрут](../../security/access.md#проверить-маршрут) |
| `Access` | Сервис проверок: `for(ctx)` — человек запроса, `as(subject, scope)` — без HTTP, `policy(scope)` | [Проверить маршрут](../../security/access.md#проверить-маршрут) |
| `SubjectAccess` | Права одного человека: `can`, `filter`, `fields`, `grants`, `principals`, `ownerIds` | там же |
| `grantsToWhere(filter)` | Фильтр как условие ORM, `"all"` или `"none"` | [Отфильтровать список](../../security/access.md#отфильтровать-список) |
| `maskFields(record, read)` | Запись только с разрешёнными полями | — |
| `AccessFilterTooLargeError` | `lookup` дал больше `access.maxInList` значений | — |

## Система прав

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `AccessPolicy` | Порт системы прав приложения: `subject`, `grants`, `ownerIds`, `principals` | [Своя система прав](../../security/access.md#своя-система-прав) |
| `RolesAccessPolicy`, `RoleSubject` | Система прав по умолчанию: роли из токена, права из `@Module({ roles })` | [Роли по умолчанию](../../security/access.md#роли-по-умолчанию) |
| Типы `Grant`, `Grants`, `Condition`, `ValueTest`, `AccessSubject`, `AccessObject`, `Scope`, `LocalizedText` | Форма грантов и условий | [Своя система прав](../../security/access.md#своя-система-прав) |
