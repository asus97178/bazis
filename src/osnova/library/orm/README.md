# ORM (`@osnova` / `@osnova/library/orm`)

ORM использует TC39 decorators, `DbContext`/`DbSet`, scoped Unit of Work и
параметризованный SQL без runtime npm dependencies.

## Запросы и сохранение

```ts
// db.users — DbSet модели с полями tenantId:string и age:number.
const adults = await db.users
  .where(user => user.tenantId.eq("team-a").and(user.age.gte(18)))
  .orderBy(user => user.id)
  .take(20)
  .asNoTracking()
  .toList();
```

Тип поля сохраняется в Operand<T>: age.eq("18") и age.contains("18") — ошибки
TypeScript. eq/ne/in принимают тип поля; строки поддерживают LIKE/contains,
упорядоченные значения — gt/gte/lt/lte. Для null есть isNull/isNotNull, а eq(null)
разрешён у nullable-полей. Динамические модели с unknown сохраняют динамический API.

Условия объединяются через .and/.or/.not. JavaScript `&&`, `||` и `!` не создают
SQL-условий. `di:generate` диагностирует такие операции над типом Predicate в
исходниках выбранной цели и прекращает генерацию до замены файлов. Это проверка
сборки: исполнение JS/any или исходников без codegen не получает этой гарантии.
После изменения запроса запускайте `di:generate` и проверку TypeScript.

Граница записи — DbContext.saveChanges(), сохраняющий все изменения контекста.
IRepository.saveChanges() остаётся alias той же операции. Для новых сервисов
внедряйте предметный DbContext, чтобы область сохранения была видна в коде.
[Подробнее о репозиториях](Repository/README.md).

## PostgreSQL exact ensureCreated

Production PostgreSQL schema описывается один раз явным списком
`ormOsnova.entities` и entity decorators. Shared connection принадлежит
`@Infra`; feature не создаёт свой PostgreSQL provider.

```ts
import { Column, DbContext, Entity, ForeignKey, Infra, Key, Module, Schema, ormOsnovaConnect } from "@osnova";

@Schema("billing")
@Entity({ table: "orders" })
class Order {
  @Key(["tenantId", "orderId"], { name: "pk_orders" })
  @Column({ type: "text" }) tenantId = "";
  @Column({ type: "text" }) orderId = "";
}

@Schema("billing")
@Entity({ table: "lines" })
@ForeignKey(() => Order, { name: "fk_lines_order", properties: ["tenantId", "orderId"] })
class OrderLine {
  @Key(["tenantId", "lineId"]) @Column({ type: "text" }) tenantId = "";
  @Column({ type: "text" }) lineId = "";
  @Column({ type: "text" }) orderId = "";
}

class BillingContext extends DbContext {}
@Infra({ db: ormOsnovaConnect(dbConfig) }) class AppInfra {}
@Module({ ormOsnova: { context: BillingContext, entities: [Order, OrderLine], ensureCreated: true } })
class BillingModule {}
```

`@Key()` declares a single primary-key component. `@Key(["a", "b"])`
declares the sole ordered composite key tuple; `@UUID()` declares a v4 UUID
key. `@ForeignKey`, `@Index`, `@Check` and `@Schema` contribute to the same
expected physical schema.

For PostgreSQL, `ensureCreated()` acquires sorted advisory locks per physical
schema and runs all catalog reads and DDL on one reserved-session transaction:

1. classifies the complete declared PostgreSQL diff before any DDL;
2. creates missing schemas and whole missing tables, or applies only safe additions;
3. safe existing-table additions are nullable columns, non-null columns with a closed literal `@Column({ default })`, immediate CHECK/FK and ordinary/unique B-tree indexes;
4. re-introspect and exact-verify before commit.

Column order is ignored, but type/nullability/default/generation and named,
ordered PK/FK/index/CHECK contracts are exact. A type/null/default/generation/
PK change, rename/drop, generated/UUID existing-table column, `NOT NULL`
column without a usable literal default, or changed/unknown object stops startup
with `ORM_SCHEMA_MIGRATION_REQUIRED` and executes zero DDL. No backfill,
rebuild, `IF NOT EXISTS` or concurrent index build is performed.

`SchemaMigrationRequiredError` and `SchemaVerificationError` include the table,
object, difference code, expected ORM state and actual database state in `message`.
The existing `code` and structured `verification.differences` remain available.
For example, an extra column produces:

```text
PostgreSQL schema change requires an explicit migration.
- Table "public"."dm_table", object "osnova_drill_unexpected": column exists in the database but is absent from the ORM model (column.unexpected); expected (ORM): absent; actual (database): present.
Check the application version and target database. Align the ORM model and database schema; apply an explicit migration if a database change is intended.
```

These diagnostics use the verifier's safe descriptors. Literal defaults and CHECK
expressions remain represented by SHA-256 fingerprints; SQL, driver errors and row
values are not added to the message. The message alone does not establish that the
target database is outdated or should be modified: first check the application and
database pairing. `Osnova.run()` prints the redacted nested error details without
console depth collapsing them to `[Object ...]`.

`ColumnOptions.default` is a closed physical literal (`null | boolean | number |
string`), not SQL and not an entity initializer. It is supported only by the
PostgreSQL exact path.

Direct `context.database.ensureCreated()` uses the same PostgreSQL admission
engine.

## Other ORM capabilities

- `where`, ordering, pagination, include and typed scalar/composite lookup;
- snapshot tracking and transactional `saveChanges()`;
- declarative FK/index/CHECK metadata;
- explicit additive `migrate()` and legacy versioned `Migration[]` paths.

The additive migration paths are separate from PostgreSQL exact admission.

## Сохранение и повтор после ошибки

`saveChanges()` внутри `database.transaction()` присоединяется к текущей
транзакции. Ошибка такого сохранения запрещает её COMMIT, даже если вызывающий
код поймал исключение. Для восстановления внутри внешней транзакции используйте
`transactionScope()` с savepoint. Автоматический повтор сохранения внутри
действующей транзакции отключён.

Если после отправки COMMIT нет достоверного ответа, ORM бросает `DbUpdateError`
с `code: "ORM_TRANSACTION_OUTCOME_UNKNOWN"`. `ExecutionStrategy` и `withRetry`
не повторяют такую операцию, включая пользовательский `isTransient`.
Все контексты, сохранявшие изменения в этой транзакции, блокируют последующие
`saveChanges()`. Сначала нужно сверить результат по данным БД, затем продолжить
в новом `DbContext`. Полученные ключи сохраняются для сверки; наличие ключа
или состояние `Unchanged` не доказывает COMMIT. Пользовательские `afterCommit`
и `afterRollback` при неизвестном исходе не вызываются.

После подтверждённого отката ключи и tracking восстанавливаются. Подтверждённый
COMMIT с ошибкой обработчика сохраняет прежний контракт `PostCommitError`.

Нативный `Bun.SQL Query.cancel()` на закреплённом Bun 1.4.0 не подтвердил
отмену уже исполняющегося запроса: шесть проверок на PostgreSQL 17.11 оставили
запрос активным спустя 1,5 секунды. Сам `cancelled === true` не доказывает отмену.
При выходе из `transactionScope()` с незавершённой операцией ORM запрещает
COMMIT. Если остался незавершённый PostgreSQL-запрос,
ORM запрещает дальнейшую работу этой reservation и вызывает `pg_cancel_backend`
через отдельное служебное соединение Bun.SQL. Она ждёт ответа команды отмены,
завершения исходных native запросов, подтверждённого ROLLBACK и readback прежней
backend identity. После этого соединение можно использовать повторно.
Неработающий `Query.cancel()` в этом пути не используется. Для незавершённого пользовательского JS без SQL сохранён предел
ожидания 5 секунд; явный сигнал отмены прерывает и это ожидание.

Долгий запрос внутри callback можно отменить снаружи:

```ts
await db.transactionScope(async (tx) => {
  await tx.databaseTime();
  await db.database.querySqlRaw("SELECT pg_sleep({0})", 30);
}, { signal: AbortSignal.timeout(1_000) });
```

Уже отменённый сигнал отклоняет вызов до BEGIN. При отмене активного scope
новые и отложенные операции блокируются. Серверная отмена откатывает всю
физическую транзакцию, включая внешнюю при отмене вложенного scope; пойманная
ошибка не разрешает её COMMIT. После завершения callback и его операций
управление передаётся провайдеру: его срок операции действует до ответа на COMMIT.
Сигнал передаётся в `reserve({ signal })`; поздно выданное соединение закрывается
без BEGIN. `options.timeoutMs` ограничивает ожидание соединения, BEGIN, callback,
SQL и COMMIT; по умолчанию используется `operationTimeoutMs` провайдера (30 секунд).
Подтверждение отмены имеет отдельный бюджет `cancellationTimeoutMs` (5 секунд),
освобождение ресурса — ещё один такой бюджет. Это не обещание завершить весь вызов
за `timeoutMs`. Пользовательские afterCommit/afterRollback имеют собственное время
исполнения; подтверждённый COMMIT поздняя отмена не меняет. Произвольный JS
не останавливается, но его поздние обращения к ORM запрещены.

Если завершение SQL и откат на прежнем backend не подтверждены, ORM возвращает
`ORM_TRANSACTION_OUTCOME_UNKNOWN` с `phase: "cancellation"`. Пользовательский
rollback callback не вызывается. Все контексты, включённые в scope, блокируют
новые SQL и сохранения; результат нужно сверить через новый контекст. Потерянный
ответ на COMMIT сохраняет `phase: "commit"`. Автоматического повтора нет.

При явном `cancellationMode: "close"` сохраняется прежняя политика закрытия и
проверки исчезновения backend. В этом режиме на Bun 1.4.0 **быстрая отмена по TLS
не подтверждена**: Promise
закрытия соединения завершается, но SQL на сервере может оставаться активным.
В проверке 10-секундного запроса backend оставался активным после пяти секунд;
ORM вернула неизвестный исход в свой бюджет. При явно настроенном серверном
`statementTimeoutMs: 600` отдельная проверка завершилась подтверждённым откатом
за 641 мс. Серверный лимит отсчитывается от начала SQL, поэтому он не гарантирует
такую задержку от любого последующего abort.

`postgres({ operationTimeoutMs, cancellationTimeoutMs, cancellationMode, maxPendingOperations,
serverTimeouts, onOperation })` настраивает политику провайдера.
`cancellationMode` принимает `server` (по умолчанию) или `close`. Server-режим
использует ленивый служебный пул max=1 дополнительно к рабочему пулу, с теми же
credentials и TLS. Оба пула закрываются вместе с provider. Borrowed advisory locks
после подтверждённого отката явно снимаются до возврата соединения.
После принудительного закрытия пул проверяет последующие reservation через SELECT 1
до пользовательской работы. Native connection timeout на допуске допускает один
повтор в общем deadline; бизнес-SQL, callback и COMMIT не повторяются. Проверка
добавляет один round trip после такого отказа до пересоздания provider; обычная
подтверждённая server cancellation её не включает.

SQL-проверка PID/backend_start/query_start не атомарна относительно системного
переиспользования PID; гарантию протокола PID+secret этот API не предоставляет.
`serverTimeouts` поддерживает `statementTimeoutMs`, `lockTimeoutMs`,
`idleInTransactionTimeoutMs`, `transactionTimeoutMs` (последний — PostgreSQL 17+).
Настройки применяются через SET LOCAL и проверяются при BEGIN; по умолчанию
серверные лимиты не меняются. Root query/execute и ping имеют клиентский deadline,
но SET LOCAL-профиль действует только внутри транзакций. Незавершённые native
операции занимают слот до фактического завершения; лимит по умолчанию — 256,
для cleanup есть ограниченный резерв. `statistics()` и `onOperation` показывают
число таких операций, длительности и неизвестные исходы без SQL и параметров.

ORM-коннектор передаёт настройки пула, подключения, TLS и указанные лимиты.
Единицы, валидация и пример подключения — в
[паспорте core/orm](../../core/orm/MODULE.md).

Результаты текущего server-режима, реальные AbortSignal-сценарии TCP/TLS и
бинарная квалификация — в [отчёте интеграции](../../../../docs/audits/orm-server-cancel-integration-2026-09-14.md).
Прежние физические проверки close-режима подтвердили отмену за 395–402 мс, rollback,
восстановление ключей, снятие advisory locks, сохранность соседнего активного
запроса в том же пуле и дальнейшие сохранения. Это измерение локального прогона,
а не срок для любой среды. [Исправление и доказательства](../../../../docs/audits/orm-2026-09-14-cancellation-fix.md),
[контракт отмены](MODULE.md). Прямой вызов `Bun.SQL Query.cancel()` остаётся
отдельным непройденным gate из [предыдущей квалификации](../../../../docs/audits/orm-2026-09-14-qualification.md).
Новые ограничения времени, сбои сети, TLS и бинарное исполнение описаны в
[отчёте доработки](../../../../docs/audits/orm-bun-sql-hardening-2026-09-14.md).

`findForUpdate()` обновляет только чистую отслеживаемую сущность. Несохранённые
обычные присваивания, изменения JSON/Date и явный `update()` вызывают отказ
до перезаписи значений. Модели только с генерируемым ключом сохраняются отдельными
`INSERT DEFAULT VALUES` внутри общей транзакции.

## Физические типы и SQL-имена

PostgreSQL FK к нативному UUID-ключу получает физический тип `uuid`; логический
`PropertyModel.type` и converters сохраняются. Это действует для явных FK,
навигаций и динамических моделей, включая составные связи и цепочки PK/FK.
Несовместимые типы отклоняются до DDL. Существующие колонки автоматически
не преобразуются: расхождение требует отдельной миграции. Exact admission
отклоняет `GENERATED ALWAYS`, если модель объявляет `BY DEFAULT`.

`PostgresDialect.quoteId()` экранирует **одно** имя:
`quoteId("external.name")` возвращает `"external.name"`. Для таблицы со схемой
используйте `qualifyTable(model)` либо соединяйте отдельно экранированные схему
и имя. Старый формат `tableName` у динамических моделей сохранён; ORM учитывает
исходные компоненты схемы и таблицы без разделения по точкам. Вручную переданный
`ForeignKeyConstraint.referencedTable` сохраняет прежний формат `schema.table`.

`include()` использует общую с identity map семантику `KeyTuple` для ссылок
и коллекций, включая `bigint`, `Date` и converter-backed бинарные ключи.
