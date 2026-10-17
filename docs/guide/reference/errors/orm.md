# Ошибки ORM

Классы — из `bazis/core/orm`, все наследуют `OrmError`. Исходная ошибка
драйвера PostgreSQL, если она была, лежит в `error.cause`.

Подробные примеры — в главах раздела «База данных», здесь — полный
список. Тексты — из исходников 0.100.8; тексты, проверенные на базе, —
в главах по ссылкам.

## Сохранение и ограничения

Подклассы `DbUpdateError` — ошибки `saveChanges()` и немедленных
изменений.

| Класс | Текст | Когда |
| --- | --- | --- |
| `UniqueViolationError` | `Unique constraint "ix_categories_name" violated.` | Повтор значения уникального индекса |
| `ForeignKeyViolationError` | `Foreign key constraint "fk_products_categoryId" violated: …` | Ссылка на несуществующую строку или удаление строки, на которую ссылаются |
| `CheckViolationError` | `Check constraint "ck_products_price" violated.` | Нарушено условие `@Check` |
| `NotNullViolationError` | `Column "title" of table "products" does not accept NULL.` | `NULL` в обязательном столбце |

Поля `constraint`, `table`, `column` — для ветвления в коде. Как
превратить их в `409` и `422` — в главе
[Ошибки базы данных](../../database/errors.md).

### `OrmValidationError`

```text
Validation failed for "Product": Field "title" is required
```

Правило `@Validator` сущности не выполнено — до SQL. Поля `entityName` и
`errors`.

### `EntityNotFoundError`

```text
Sequence contains no elements for entity "Product".
```

`first()` не нашёл строку. Если строки может не быть —
`firstOrDefault()`. С `databaseErrorStatus` — `404`.

### `EntityNotMappedError`

```text
Type "Product" is not mapped in this DbContext. Add it to ormModule({ entities: [...] }) and annotate it with @Entity().
```

Класс не зарегистрирован в контексте. Другие варианты того же класса:

```text
No entity or dynamic model named "Notes" is registered in this DbContext. Register a dynamic table first: options.model.registerModel(buildDynamicModel({ name: "Notes", fields: [...] })).
A plain object is not an entity class. For a dynamic table add the row through its set: db.setByName("Table").add(row).
```

([Динамические модели](../../database/dynamic-models.md)).

### `ModelBuildError`

```text
CHECK references unknown property "prise".
```

Модель сущностей собрать нельзя: неверное условие `@Check`, неизвестное
свойство, неподдерживаемая форма. Ошибка при запуске; текст называет
место.

## Транзакции

| Класс | Текст | Что сделать |
| --- | --- | --- |
| `LockTimeoutError` | `A lock was not granted within lockTimeoutMs: another transaction holds the row or table. Retry …` | Повторить позже или сократить транзакцию, которая держит блокировку |
| `TransactionOutcomeUnknownError` | `The database did not answer …: ORM operation …` | База не ответила, данные могли записаться: проверить состояние, прежде чем повторять. Код `ORM_TRANSACTION_OUTCOME_UNKNOWN` |
| `OrmTransactionScopeError` | `ORM transaction scope timed out after 5000 ms.` / `ORM transaction scope is not active for this operation.` | Тайм-аут или отмена транзакции; контекст использован после её конца |
| `ConcurrentTransactionScopeError` | `Concurrent sibling transaction scopes on one ambient connection are not supported; await each scope sequentially.` | Вложенные транзакции — по очереди, с `await` |
| `OrmProviderIdentityMismatchError` | `OtherDb uses a different database provider than the surrounding transaction scope. …` | Контексты в одной транзакции — с одним подключением |
| `PostCommitError` | — | Транзакция **записана**, но упал обработчик `afterCommit`. `committed: true`, ошибки — в `errors`. Не повторять транзакцию |
| `OrmDatabaseTimeError` | `ORM provider returned an invalid database time value.` | Внутренняя: база вернула неверное время |

Подробно — в главе [Транзакции](../../database/transactions.md#ошибки).

## Немедленные изменения

Ошибки `executeUpdate`, `executeDelete`, `insertIfAbsent`
([Немедленные изменения](../../database/immediate.md)):

| Класс | Текст |
| --- | --- |
| `OrmTrackedMutationConflictError` | `Immediate ORM mutation conflicts with tracked entities: this context tracks "Post" entities (loaded with tracking or saved through saveChanges()), which the mutation would make stale. Load them with .asNoTracking(), or run the mutation in a separate DbContext.` |
| `OrmUndeclaredConflictTargetError` | `Immediate ORM mutation conflict target is not a declared unique key: conflictBy (slug) is not the primary key or a unique index of Post. Use one of: …; or declare @Index({ unique: true }) on these properties.` |
| `OrmUnsafeImmediateMutationError` | `Immediate ORM mutation input is unsafe or unsupported: <причина>.` |

## Схема

### `SchemaAdmissionError`

Схему при запуске применить нельзя. Код — в поле `code` и в тексте:
`SchemaAdmissionError [ORM_SCHEMA_OWNERSHIP_CONFLICT]: …`.

| Код | Когда |
| --- | --- |
| `ORM_SCHEMA_ADDITIVE_DATA_VIOLATION` | Данные мешают безопасному изменению: например, `NULL` в столбце, который становится обязательным ([Схема](../../database/schema.md#что-добавляется-само)) |
| `ORM_SCHEMA_OWNERSHIP_CONFLICT` | Одну таблицу создают два контекста ([Несколько модулей](../../database/schema.md#несколько-модулей)) |
| `ORM_SCHEMA_CROSS_UNIT_FOREIGN_KEY` | Внешний ключ на сущность другого контекста |
| `ORM_SCHEMA_HOSTED_PHASE_CONFLICT` | Служба приложения запускается раньше схемы (фаза меньше 0); нужна `phase: 0` или позже |
| `ORM_SCHEMA_CREATE_FAILED` | `PostgreSQL additive schema admission failed: …` при создании схемы или таблицы — обычно нет прав `CREATE` |
| `ORM_SCHEMA_ADDITIVE_DDL_FAILED` | То же при добавлении столбца или индекса |
| `ORM_SCHEMA_LOCK_UNAVAILABLE` | `PostgreSQL schema admission lock is unavailable.` — другой экземпляр держит блокировку схемы дольше срока, или связь с базой оборвалась |
| `ORM_SCHEMA_PROVIDER_UNSUPPORTED` | `PostgreSQL schema admission capability is unavailable.` — не PostgreSQL или не подключение из `@Infra` |
| `ORM_SCHEMA_CATALOG_UNSUPPORTED` | В базе форма схемы, которую ORM не умеет сравнить |
| `ORM_SCHEMA_MODEL_INVALID` | `The declared ORM model cannot be admitted.` |
| `ORM_SCHEMA_ATOMICITY_UNAVAILABLE`, `ORM_SCHEMA_LOCK_KEY_COLLISION` | Внутренние: проверку схемы нельзя выполнить безопасно |

### `SchemaMigrationRequiredError`

```text
[bazis] application failed: SchemaMigrationRequiredError [ORM_SCHEMA_MIGRATION_REQUIRED]: PostgreSQL schema change requires an explicit migration.
```

Изменение модели нельзя применить само — переименование, смена типа,
удаление. В тексте — список различий и что сделать
([Что требует миграции](../../database/schema.md#что-требует-миграции)).

### `SchemaVerificationError`

```text
SchemaVerificationError [ORM_SCHEMA_DRIFT]: PostgreSQL schema does not match the declared model.
```

Схема в базе отличается от модели, и это не изменение, которое ORM
применяет сам: таблицу поправили руками или приложение старой версии.
Различия — списком, по коду: `column.missing`, `column.type`,
`index.unexpected`, `foreignKey.actions`…

### `OrmOwnedStoreAdmissionError`

Ошибки [собственных хранилищ](../../database/owned-stores.md):

| Код | Когда |
| --- | --- |
| `ORM_OWNED_STORE_IDENTITY_MISMATCH` | Модель, версия формата или область отличаются от записанных |
| `ORM_OWNED_STORE_IDENTITY_MISSING` | В области есть таблицы, которые хранилище не создавало |
| `ORM_OWNED_STORE_OWNERSHIP_CONFLICT` | Таблица вне префикса, пересечение областей |
| `ORM_OWNED_STORE_DRIFT` | Таблицы области изменены снаружи |
| `ORM_OWNED_STORE_CREATE_FAILED` | Не удалось создать таблицы |
| `ORM_OWNED_STORE_LOCK_UNAVAILABLE` | Запуск прерван: связь с базой, отмена, долгая блокировка |
| `ORM_OWNED_STORE_PROVIDER_UNSUPPORTED` | Не PostgreSQL или не общее подключение из `@Infra` |

## Ошибки кода

`BAZIS_ORM_PREDICATE_LOGIC` — `&&` или `||` в условии `where`; ловит
кодогенерация ([Ошибки кодогенерации](codegen.md#bazis_orm_predicate_logic)).

## Дальше

- [Ошибки базы данных](../../database/errors.md)
- [Схема](../../database/schema.md)
- [Транзакции](../../database/transactions.md)
