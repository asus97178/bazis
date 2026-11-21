# `bazis/core/access`

Права модулей: каталог permissions, проверки и фильтры списков по грантам
системы прав приложения. Список — по пакету 0.142.0.

## Модуль и объявления

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `AccessModule` | Подключается один раз: каталог, `IAccess`, роли по умолчанию, `/access/catalog`, `/access/references/:kind` | [Объявить права](../../module/access.md#объявить-права) |
| `definePermissions({...})` | Права модуля для `@Module({ permissions })`: `title`, `description`, `scope`, `on`, `owner`, `fields` | [Объявить права](../../module/access.md#объявить-права) |
| `defineRoles({...})` | Роли системы прав по умолчанию для `@Module({ roles })`; `"<право>:own"` — только своё | [Роли по умолчанию](../../module/access.md#роли-по-умолчанию) |
| `References` | Значения вида ссылки для `@Module({ references })`: `exists`, `describe`, `search` | [Ссылки и каталог](../../module/access.md#ссылки-и-каталог-для-админки) |
| `AttributeLookup` | Атрибут или раздел, которого нет в колонках строки: `toColumn(values)` → `{ column, in }` | [Объявить права](../../module/access.md#объявить-права) |
| `PermissionSource`, `PermissionSourceVersion` | Права, которые появляются во время работы, для `@Module({ permissionSources })`: `version()` (число или непустая строка), `load(keys?)` | [Права во время работы](../../module/access.md#права-которые-появляются-во-время-работы) |
| `IAccessCatalog` | Права, виды ссылок и роли всех модулей приложения; `grantProblem(permission, grant)` — проверка правила при сохранении, `changed(prefix, keys?)` — источник изменился, `sources()` — состояние источников, `find(key)` — право для проверки | [Проверить правило](../../module/access.md#проверить-правило-при-сохранении) |
| `accessConfig` | Настройки `access.kindClaim`, `access.roleClaim`, `access.maxInList`, `access.sourcePollSeconds`, `access.sourceTimeoutSeconds` | [Роли по умолчанию](../../module/access.md#роли-по-умолчанию) |
| `AccessSetupError` | Ошибка объявлений при сборке приложения | [Объявить права](../../module/access.md#объявить-права) |

## Проверки

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `can(permission, objectOf?)` | Проверка маршрута: `401` без человека, `403` без права; без объекта — право хоть где-нибудь | [Проверить маршрут](../../module/access.md#проверить-маршрут) |
| `IAccess` | Сервис проверок: `for(ctx)` — человек запроса, `as(subject, scope)` — без HTTP, `policy(scope)` | [Проверить маршрут](../../module/access.md#проверить-маршрут) |
| `BazisPermissions`, `PermissionKey`, `OwnPermissionKey`, `PermissionsOf` | Объявленные права как тип: интерфейс заполняет codegen, `PermissionKey` принимают `can` и `defineRoles` | [Ключи проверяет компилятор](../../module/access.md#ключи-проверяет-компилятор) |
| `BazisPermissionSources`, `SourcePermissionKey`, `AnyPermissionKey` | Ключи источников как тип: `` `${префикс}.${string}` ``; `AnyPermissionKey` принимают `can`, `access.can`, `access.filter`, `access.fields` | [Права во время работы](../../module/access.md#права-которые-появляются-во-время-работы) |
| `SubjectAccess` | Права одного человека: `can`, `explain`, `filter`, `fields`, `filterableFields`, `grants`, `principals`, `ownerIds` | там же |
| `AccessExplanation`, `GrantExplanation` | Ответ `explain`: итог `can` и каждый грант с `id`, `scope`, `where`, `applies`, `problem`, `fields` | [Объяснить решение](../../module/access.md#объяснить-решение) |
| `grantsToWhere(filter)` | Фильтр как условие ORM, `"all"` или `"none"` | [Отфильтровать список](../../module/access.md#отфильтровать-список) |
| `AccessFilter`, `ColumnCondition` | Фильтр как данные, для модуля без ORM: `all`, `any`, `not`, `{ column, in }`, `{ column, isNull }`, `{ column, op, value }` | — |
| `maskFields(record, read)` | Запись только с разрешёнными полями | [Поля в списке](../../module/access.md#поля-в-списке) |
| `AccessFilterTooLargeError` | `lookup` дал больше `access.maxInList` значений | — |

## Система прав

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `AccessPolicy` | Порт системы прав приложения: `subject`, `grants`, `ownerIds`, `principals` | [Своя система прав](../../module/access.md#своя-система-прав) |
| `RolesAccessPolicy`, `RoleSubject` | `AccessPolicy` по умолчанию: роли из токена, права из `@Module({ roles })`; приложение заменяет её своей регистрацией `AccessPolicy` | [Роли по умолчанию](../../module/access.md#роли-по-умолчанию) |
| Типы `Grant`, `Grants`, `Condition`, `ValueTest`, `CompareTest`, `AccessSubject`, `AccessObject`, `Scope`, `LocalizedText` | Форма грантов и условий; `Grant.id` — метка правила системы прав; `CompareTest` — `gt`, `gte`, `lt`, `lte` | [Сравнения чисел](../../module/access.md#сравнения-чисел) |
