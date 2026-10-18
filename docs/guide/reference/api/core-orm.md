# `bazis/core/orm`

ORM: сущности, контекст, запросы, сохранение, транзакции, схема, ошибки
базы. Всё, что есть в `bazis/library/orm`, плюс подключение к приложению:
модуль, коннектор `@Infra`, репозитории, страницы списков. Список — по
пакету 0.104.1.

## Подключение

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `ormBazisConnect(dbConfig, options)` | Коннектор PostgreSQL для `@Infra`: подключение, схема при запуске, здоровье | [Подключение PostgreSQL](../../database/postgresql.md#инфраструктура) |
| `ormModule(config)` | Регистрация контекста модуля: `context`, `entities`, `ensureCreated`, `migrations` | [DbContext](../../database/dbcontext.md) |
| `postgres(options)` | Подключение для `ormModule({ provider: postgres(...) })` без `@Infra` | — |
| `DATABASE_PROVIDER` | Токен общего подключения | — |
| `OrmLifecycle`, `OrmConnectionLifecycle`, `OrmProviderReadyLifecycle` | Службы запуска схемы и закрытия подключения; создаёт `ormModule` | — |

## Сущности

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Entity(options)` | Класс — таблица | [Сущности](../../database/entities.md#таблица) |
| `Column(options)`, `Required()` | Столбец; `NOT NULL` | [Столбцы](../../database/entities.md#столбцы) |
| `Key(options)`, `UUID(options)` | Первичный ключ; ключ UUID (v7) | [Ключи](../../database/entities.md#ключи) |
| `CreatedAt()`, `UpdatedAt()` | Время создания и изменения | [Время создания и изменения](../../database/entities.md#время-создания-и-изменения) |
| `Index(options)`, `Check(name, predicate)` | Индекс; условие `CHECK` | [Индексы и проверки](../../database/entities.md#индексы-и-проверки) |
| `ManyToOne`, `OneToMany`, `ForeignKey` | Связи и внешний ключ | [Связи](../../database/queries.md#связи-и-include) |
| `Schema(name)` | Схема PostgreSQL таблицы | — |
| `SoftDelete()` | Мягкое удаление: `remove()` ставит время вместо `DELETE` | [Мягкое удаление](../../database/immediate.md#мягкое-удаление-и-фильтры) |
| `QueryFilter(predicate)` | Условие, которое добавляется ко всем запросам сущности; с контекстом — для арендаторов | [Арендаторы](../../security/authorization-patterns.md#арендаторы) |
| `HasConversion(converter)`, `ValueConverters` | Преобразование значения столбца; `ValueConverters.json()`, `ValueConverters.encrypted(secret)` — ключ в коде, для ORM без приложения. `null` конвертер не получает, если не объявил `convertsNulls` | [Преобразование значения](../../database/entities.md#преобразование-значения) |
| `encryptedWith(config, field)` | Шифрование столбца AES-256-GCM ключом из настроек; ключ читается при запуске | [Шифрование столбца](../../database/entities.md#шифрование-столбца) |
| `DecryptionError` | Значение не расшифровать: другой ключ или изменённые данные | [Шифрование столбца](../../database/entities.md#шифрование-столбца) |
| `buildDynamicModel(definition)` | Модель таблицы из описания, без классов | [Динамические модели](../../database/dynamic-models.md) |
| `pluralize(name)` | Множественное число для имени таблицы по умолчанию | — |

## Контекст и запросы

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `DbContext` | Базовый класс контекста: наборы, `saveChanges`, `database` | [DbContext](../../database/dbcontext.md) |
| `DbSet` | Таблица в контексте: запросы, `add`, `update`, `remove`, `find` | [`DbSet`](../../database/dbcontext.md#dbset) |
| `DbContextOptions`, `DbContextFactory` | Опции контекста; фабрика контекстов для ORM без приложения — в приложении вместо неё `createScope()` | [Вне запроса](../../database/dbcontext.md#вне-запроса) |
| `DatabaseFacade` | `db.database`: схема, сырой SQL, транзакции, проверка связи | [Сырой SQL](../../database/dbcontext.md#сырой-sql) |
| `EntityQuery`, `IncludableQuery`, `ProjectedQuery` | Запросы: `where`, `orderBy`, `include`, `select`, `toList`, `first` | [Запросы](../../database/queries.md) |
| `Operand`, `Predicate` | Условия: `t.done.eq(false).and(…)` | [Условия](../../database/queries.md#условия) |
| `paginate(query, listQuery)` | Страница списка JSON:API: фильтры, сортировка, `total` | [Списки](../../http/lists.md#контроллер-и-сервис) |
| `ChangeTracker`, `EntityState` | Отслеживание изменений и состояния сущностей | [Состояния](../../database/saving.md#состояния) |
| `KeyTuple` | Значение составного ключа | [Составной ключ](../../database/entities.md#составной-ключ) |

## Репозитории

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `IRepository<T>` | Контракт репозитория сущности; внедряется по типу | [Репозитории](../../database/repositories.md) |
| `Repository`, `repositoryFor(Entity)`, `registerRepositories` | Реализация, токен, регистрация | там же |

## Транзакции и надёжность

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `OrmTransaction` | Транзакция из `db.database.transaction(...)` | [Транзакции](../../database/transactions.md) |
| `isCommittedOutcome`, `isUnknownTransactionOutcome` | Проверка исхода транзакции | [Тайм-ауты](../../database/errors.md#тайм-ауты-и-недоступная-база) |
| `ExecutionStrategy`, `withRetry(provider, options)` | Повторы при временных сбоях (как `EnableRetryOnFailure` в EF Core); в приложении — `executionStrategy` модуля | [Повтор при временном сбое](../../database/saving.md#повтор-при-временном-сбое) |
| `withoutExecutionStrategyRetries` | Отключить вложенные повторы для подсистемы со своими | — |

## Схема

| Экспорт | Что это | Подробно |
| --- | --- | --- |
| `Migrator`, `MigrationRunner`, `SchemaDiffer` | Применение изменений схемы, миграции с историей, сравнение модели с базой | [Схема](../../database/schema.md) |
| `ModelBuilder`, `OrmModel` | Сборка модели из декораторов | — |
| `compileCheck`, `renderCheck` | Перевод условия `@Check` в SQL | — |
| `defineOrmOwnedStoreV1(descriptor)` | Описание собственного хранилища пакета | [Собственные хранилища](../../database/owned-stores.md) |
| `PostgresProvider`, `PostgresDialect` | Провайдер PostgreSQL на встроенном `SQL` Bun | [PostgreSQL](../../database/postgresql.md) |

## Ошибки

| Экспорт | Что это |
| --- | --- |
| `translateDatabaseError(error)` | Ошибка драйвера с известным SQLSTATE → класс ORM |
| `databaseErrorStatus(error)` | HTTP-статус ошибки базы для `errorHandler.status`: 409, 422, 404, 503 |

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
