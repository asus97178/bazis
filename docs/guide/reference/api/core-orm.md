# `bazis/core/orm`

ORM: сущности, контекст, запросы, сохранение, транзакции, схема, ошибки
базы. Всё, что есть в `bazis/library/orm`, плюс подключение к приложению:
модуль, коннектор `@Infra`, репозитории, страницы списков. Список — по
пакету 0.128.0.

## Подключение

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `ormBazisConnect(dbConfig, options)` | Коннектор PostgreSQL для `@Infra`: подключение, схема при запуске, здоровье | [Подключение PostgreSQL](../../module/database/postgresql.md#инфраструктура) |
| `ormModule(config)` | Регистрация контекста модуля: `context`, `ensureCreated`, `migrations`; `entities` — только для сущностей без набора | [DbContext](../../module/database/dbcontext.md) |
| `postgres(options)` | Подключение для `ormModule({ provider: postgres(...) })` без `@Infra` | — |
| `DATABASE_PROVIDER` | Токен общего подключения | — |
| `OrmLifecycle`, `OrmConnectionLifecycle`, `OrmProviderReadyLifecycle` | Службы запуска схемы и закрытия подключения; создаёт `ormModule` | — |

## Сущности

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Entity(options)` | Класс — таблица | [Сущности](../../module/database/entities.md#таблица) |
| `Column(options)`, `Required()`, `Nullable()` | Столбец; метка `NOT NULL` или «NULL можно», одна из двух обязательна | [Столбцы](../../module/database/entities.md#столбцы) |
| `Key(options)`, `UUID(options)` | Первичный ключ; ключ UUID (v7) | [Ключи](../../module/database/entities.md#ключи) |
| `CreatedAt()`, `UpdatedAt()` | Время создания и изменения | [Время создания и изменения](../../module/database/entities.md#время-создания-и-изменения) |
| `Index(options)`, `Check(name, predicate)` | Индекс; условие `CHECK` | [Индексы и проверки](../../module/database/entities.md#индексы-и-проверки) |
| `ManyToOne`, `OneToMany`, `ForeignKey` | Связи и внешний ключ | [Связи](../../module/database/queries.md#связи-и-include) |
| `Schema(name)` | Схема PostgreSQL таблицы | — |
| `SoftDelete()` | Мягкое удаление: `remove()` ставит время вместо `DELETE` | [Мягкое удаление](../../module/database/immediate.md#мягкое-удаление-и-фильтры) |
| `QueryFilter(predicate)` | Условие, которое добавляется ко всем запросам сущности; с контекстом — для арендаторов | [Арендаторы](../../security/authorization-patterns.md#арендаторы) |
| `HasConversion(converter)`, `ValueConverters` | Преобразование значения столбца; `ValueConverters.json()`, `ValueConverters.encrypted(secret)` — ключ в коде, для ORM без приложения. `null` конвертер не получает, если не объявил `convertsNulls` | [Преобразование значения](../../module/database/entities.md#преобразование-значения) |
| `encryptedWith(config, field)` | Шифрование столбца AES-256-GCM ключом из настроек; ключ читается при запуске | [Шифрование столбца](../../module/database/entities.md#шифрование-столбца) |
| `DecryptionError` | Значение не расшифровать: другой ключ или изменённые данные | [Шифрование столбца](../../module/database/entities.md#шифрование-столбца) |
| `buildDynamicModel(definition)` | Модель таблицы из описания, без классов | [Динамические модели](../../module/database/dynamic-models.md) |
| `pluralize(name)` | Множественное число для имени таблицы по умолчанию | — |

## Контекст и запросы

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `DbContext` | Базовый класс контекста: наборы, `saveChanges`, `database` | [DbContext](../../module/database/dbcontext.md) |
| `DbSet` | Таблица в контексте: запросы, `add`, `update`, `remove`, `find` | [`DbSet`](../../module/database/dbcontext.md#dbset) |
| `DbContextOptions`, `DbContextFactory` | Опции контекста; фабрика контекстов для ORM без приложения — в приложении вместо неё `createScope()` | [Вне запроса](../../module/database/dbcontext.md#вне-запроса) |
| `DatabaseFacade` | `db.database`: схема, сырой SQL, транзакции, проверка связи | [Сырой SQL](../../module/database/dbcontext.md#сырой-sql) |
| `EntityQuery`, `IncludableQuery`, `ProjectedQuery` | Запросы: `where`, `orderBy`, `include`, `select`, `toList`, `first` | [Запросы](../../module/database/queries.md) |
| `Operand`, `Predicate` | Условия: `t.done.eq(false).and(…)` | [Условия](../../module/database/queries.md#условия) |
| `paginate(query, listQuery)` | Страница списка JSON:API: фильтры, сортировка, `total` | [Списки](../../module/controllers/lists.md#контроллер-и-сервис) |
| `ChangeTracker`, `EntityState` | Отслеживание изменений и состояния сущностей | [Состояния](../../module/database/saving.md#состояния) |
| `KeyTuple` | Значение составного ключа | [Составной ключ](../../module/database/entities.md#составной-ключ) |

## Репозитории

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `IRepository<T>` | Контракт репозитория сущности; внедряется по типу | [Репозитории](../../module/database/repositories.md) |
| `Repository`, `repositoryFor(Entity)`, `registerRepositories` | Реализация, токен, регистрация | там же |

## Транзакции и надёжность

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `OrmTransaction` | Транзакция из `db.database.transaction(...)` | [Транзакции](../../module/database/transactions.md) |
| `isCommittedOutcome`, `isUnknownTransactionOutcome` | Проверка исхода транзакции | [Тайм-ауты](../../module/database/errors.md#тайм-ауты-и-недоступная-база) |
| `ExecutionStrategy`, `withRetry(provider, options)` | Повторы при временных сбоях (как `EnableRetryOnFailure` в EF Core); в приложении — `executionStrategy` модуля и `transactionScope(work, { retry: true })` | [Повтор при временном сбое](../../module/database/saving.md#повтор-при-временном-сбое), [повтор транзакции](../../module/database/transactions.md#повтор-при-взаимной-блокировке) |
| `withoutExecutionStrategyRetries` | Отключить вложенные повторы для подсистемы со своими | — |

## Схема

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Migrator`, `MigrationRunner`, `SchemaDiffer` | Применение изменений схемы, миграции с историей, сравнение модели с базой | [Схема](../../module/database/schema.md) |
| `ModelBuilder`, `OrmModel` | Сборка модели из декораторов | — |
| `compileCheck`, `renderCheck` | Перевод условия `@Check` в SQL | — |
| `defineOrmOwnedStoreV1(descriptor)` | Описание собственного хранилища пакета | [Собственные хранилища](../../module/database/owned-stores.md) |
| `PostgresProvider`, `PostgresDialect` | Провайдер PostgreSQL на встроенном `SQL` Bun | [PostgreSQL](../../module/database/postgresql.md) |

## Ошибки

| Экспорт | Что это |
| --- | --- |
| `translateDatabaseError(error)` | Ошибка драйвера с известным SQLSTATE → класс ORM |
| `databaseErrorStatus(error)` | HTTP-статус ошибки базы: 409, 422, 404, 503. Приложение применяет его само |
| `databaseHttpError(error)` | Ошибка базы как `HttpError`: статус, а для занятого значения текст `conflict` и свойства индекса. Зарегистрирована как `HTTP_ERROR_MAPPER` |

Классы: `OrmError`, `DbUpdateError`, `UniqueViolationError`,
`ForeignKeyViolationError`, `CheckViolationError`, `NotNullViolationError`,
`LockTimeoutError`, `OrmValidationError`, `EntityNotFoundError`,
`EntityNotMappedError`, `ModelBuildError`, `DecryptionError`, `TransactionOutcomeUnknownError`,
`OrmTransactionScopeError`, `ConcurrentTransactionScopeError`,
`OrmProviderIdentityMismatchError`, `PostCommitError`, `OrmDatabaseTimeError`,
`OrmTrackedMutationConflictError`, `OrmUndeclaredConflictTargetError`,
`OrmUnsafeImmediateMutationError`, `SchemaAdmissionError`,
`SchemaMigrationRequiredError`, `SchemaVerificationError`,
`OrmOwnedStoreAdmissionError` — [Ошибки ORM](../errors/orm.md).

## Типы

- **Модуль и подключение:** `OrmModuleConfig`, `PostgresOrmConfigShape`,
  `PostgresProviderOptions`, `PostgresServerTimeouts`,
  `PostgresOperationEvent`, `DatabaseProvider`, `DatabaseProviderLimits`,
  `DatabaseProviderDiagnostic`, `DbContextOptionsConfig`, `DbExecutor`,
  `SqlDialect`, `SqlParam`, `ExecuteResult`, `Row`,
  `NotificationSubscription`.
- **Модель:** `EntityModel`, `EntityOptions`, `PropertyModel`,
  `PropertyConvention`, `RelationModel`, `RelationKind`, `RelationOptions`,
  `NavigationElement`, `ColumnOptions`, `ColumnOptionsType`, `ColumnType`,
  `SemanticColumnType`, `StorageColumnType`, `LogicalFieldType`,
  `ScalarLogicalFieldType`, `ColumnDefaultValue`, `CanonicalDefault`,
  `KeyOptions`, `KeyGeneration`, `GenerationStrategy`, `UUIDOptions`,
  `IndexOptions`, `IndexModel`, `ForeignKeyModel`, `ForeignKeyConstraint`,
  `ReferentialAction`, `ValueConverter`.
- **Условия `CHECK`:** `CheckAst`, `CheckExpression`, `CheckField`,
  `CheckModel`, `CheckOperand`, `CheckPredicate`, `CheckScalar`.
- **Динамические модели:** `DynamicTableDefinition`,
  `DynamicEntityDefinition`, `DynamicFieldDefinition`,
  `DynamicPrimaryKeyDefinition`, `DynamicForeignKeyDefinition`,
  `DynamicIndexDefinition`, `DynamicCheckDefinition`,
  `DynamicRelationDefinition`, `DynamicTargetResolver`.
- **Запросы и сохранение:** `FieldSelector`, `PredicateFn`,
  `KeySelectorFn`, `TrackedEntry`, `PageResult`, `RowLockMode`,
  `ForUpdateOptionsV1`, `OrmMutationResultV1`, `OrmInsertIfAbsentResultV1`,
  `OrmUpdateValuesV1`, `OrmUniqueKeySelectorV1`.
- **Транзакции:** `OrmTransactionScopeOptions`, `TransactionCallback`,
  `AfterCommitCallback`, `ExecutionStrategyOptions`, `OrmDatabaseTimeV1`.
- **Схема и миграции:** `Migration`, `MigrationContext`, `MigrationResult`,
  `VersionedMigrationResult`, `EnsureCreatedResult`,
  `EnsureCreatedWithMigrationsResult`, `AdditiveSchemaOperation`,
  `SchemaDiff`, `SchemaDifference`, `SchemaDifferenceCode`,
  `SchemaVerificationResult`, `SafeSchemaDescriptor`,
  `SchemaAdmissionErrorCode`, `IntrospectedSchema`, `IntrospectedTable`,
  `IntrospectedColumn`, `IntrospectedIndex`, `IntrospectedForeignKey`,
  `IntrospectedPrimaryKey`, `IntrospectedCheck`.
- **Собственные хранилища:** `OrmOwnedStoreDefinitionV1`,
  `OrmOwnedStoreAdmissionErrorCode`, `OrmCatalogScopeV1`.
