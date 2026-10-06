# ORM: operation timeouts and transactionScope cancellation

Passport version: 9. Check date: 2026-10-05.
Status: server cancellation is integrated; TCP/TLS and binary qualification results are in section 6. Production topologies and other platforms are not qualified.
Type: an existing atomic library feature that manages ORM transactions.
Path: `src/bazis/library/orm`.
Connection point: `DbContext`; the DI integration is `core/orm/ormModule.ts`.
Passport scope: `DbContext.transactionScope(work, options?)`, the timeouts of the regular
PostgresProvider query/execute/ping/close and the operational options.
The version 5 addendum describes the internal reader/provider boundary for owned-store.
The whole lifecycle of schema admission, owned-store and migrations is not covered here.
A reader is created per read and is not exported through the public barrel.
The provider still owns phase/generation, locks, timeouts, cancellation,
quarantine and release/close. The protocol, SQL order, limits and public DTOs are kept.

## 1. Responsibility and structure

The coordinator owns the logical transaction scope, its operations, contexts and the
ban on late SQL. `PostgresProvider` owns the physical connection and the original
native operations, a separate control connection and the rollback proof. No new submodules are needed.
Running arbitrary user JavaScript and the Bun driver are outside this boundary;
cancellation does not stop arbitrary JS code.

## 2. Components

| Component | File | Change |
| --- | --- | --- |
| Public entry | `DbContext.ts`, `Transactions/OrmTransaction.ts`, `index.ts` | Optional options with an AbortSignal |
| Coordinator | `Transactions/TransactionScopeCoordinator.ts` | The cancellation signal, closing and the ban on late operations |
| Physical owner | `Providers/PostgresProvider.ts` | Fencing the reservation, server cancellation, native settlement and a confirmed ROLLBACK |
| Owned-store reading | `Providers/OwnedStoreCatalog.reader.ts` | Registry/catalog SQL, strict wire decoding, budgets and frozen snapshots. Only query/assertActive/unavailable/drift; the connection and the attempt are not accessible |
| Schema decoding | `Providers/PostgresSchema.decoder.ts` | Shared pure type/default/check rules for regular introspection and owned-store |
| Private link | `Providers/ormTransactionRuntime.ts` | The coordinator passes cancellation completion to the physical owner |
| Timeouts | `Providers/operationDeadline.ts` | The timer, the AbortSignal and listener removal; a bounded wait does not prove native work stopped |
| Unknown outcome | `Providers/transactionOutcome.ts` | phase=commit/cancellation, internal tracking hooks without fake user callbacks |
| Integration | `core/orm/databaseConnector.ts` | Pool, TLS, timeouts and signal lifecycle through the existing DATABASE_PROVIDER |
| Checks | `test/orm.server-cancellation.test.ts`, `test/orm.server-cancellation.postgres.live.test.ts`, the existing scope/cancellation suites | Signal, native settlement, queue, lost response, TLS, rollback, tracking, borrowed locks and pool isolation |

HTTP, UI, AI, background handlers, events and new entities are not used.

## 3. Connection and DI

There are no new registrations, imports or DI exports. The existing `ormModule` passes
the shared `DATABASE_PROVIDER` to contexts; the lifetime of the provider and the contexts
is kept. The TypeScript public entry is `library/orm/index.ts`, re-exported in
`core/orm/index.ts`. For application reconciliation of an outcome,
`TransactionOutcomeUnknownError` and `isUnknownTransactionOutcome(error: unknown): boolean`
are public. The classifier checks the code, cause and AggregateError without calling
getters; overly deep wrapping is conservatively treated as unsafe to retry. A `true`
result proves neither COMMIT nor ROLLBACK and does not allow retrying the business
operation without its own key.
`OrmTransactionScopeOptions` got timeoutMs; the new types `PostgresServerTimeouts` and
`PostgresOperationEvent` describe the configuration and the event. The private
cancellation policy is not exported through the barrel. The `ormModule` factory does not change.

## 4. Data, configuration and lifecycle

There are no new tables, migrations or ports. The optional configuration fields are
listed below; application settings do not change automatically. The callback runs on the
existing physical owner, and a nested scope uses a savepoint.
On cancellation the reservation immediately forbids new SQL and release. In server mode a
separate lazy Bun.SQL pool max=1 sends pg_cancel_backend for the active SQL of this owner.
The backend PID/start, datid, postmaster start, address/port, role and query_start are
checked. The full SQL text is not used. A repeated cancellation shares one Promise; a
finished dispatch and an old owner do not cancel a future borrower.
After the control SQL responds, the **original native Promises** are awaited, then the
ROLLBACK response and a readback of the same backend identity. Only after that are
rollback callbacks published and the connection allowed to be reused. With zero pending
operations the held transaction can be rolled back at once without a cancel request.

Server cancellation of a nested scope keeps the former semantics: the whole physical
transaction is rolled back. The parent becomes rollback-only. A borrowed migration/schema
owner stays forbidden for user work until the external release; its session-level
advisory locks are released explicitly before release. If unlock fails, the connection
is closed before it may return to the pool.

When the service connection is unavailable, a response is lost, the original
SQL/ROLLBACK does not finish or the backend readback changes, the wait is bounded by
cancellationTimeoutMs. The result is ORM_TRANSACTION_OUTCOME_UNKNOWN with
phase=cancellation; user callbacks are not published, and the affected contexts forbid
SQL and saves. The working and the unfinished control reservations are closed. A late
service slot is closed without SQL. Unfinished native operations hold
maxPendingOperations capacity; the number of concurrently waiting cancellations is also
bounded by this limit. The control pool gets no slot from the working pool. On provider
close both pools are closed; a new cancellation does not open a connection after shutdown.
There are no endless background checks: after unknown the application reconciles the
business result through a new context. The root pool stays usable if the database is
reachable. There is no automatic retry of a cancelled callback.

After a reservation is forcibly closed, its pool checks every new reservation for the
rest of the provider's life with an internal read-only SELECT 1 before BEGIN and business
SQL. Bun 1.4.0 may hand out a closing TLS slot before its internal handlers finish: the
first check of such a slot ends with a connection timeout. Getting/checking admission is
retried at most once, only on the native ERR_POSTGRES_CONNECTION_TIMEOUT and within the
original operation deadline. A bad reservation is closed before the retry. This is not a
retry of the callback, business SQL or COMMIT. The cost after such a failure is one extra
round trip on later handouts of this pool. A healthy server cancellation keeps the
reservation and does not enable this check. This restores client availability; it does
not prove that unknown SQL stopped on the server.


## 5. Public entry

```ts
transactionScope<TResult>(
  work: (transaction: OrmTransaction) => Promise<TResult>,
  options?: OrmTransactionScopeOptions,
): Promise<TResult>

await db.transactionScope(async (tx) => {
  await tx.databaseTime();
}, { signal: AbortSignal.timeout(1_000) });
```

The consumer is application code that already has a DbContext; there are no new access rules.

| Field | Type | Required / null | Default | Validation |
| --- | --- | --- | --- | --- |
| work | An async callback with OrmTransaction | Yes / no | None | The existing callback contract |
| options | OrmTransactionScopeOptions | No / no | No external signal; a 30 s timeout or the provider default | Used by the coordinator |
| options.signal | AbortSignal | No / no | No external cancellation | A native AbortSignal; a wrong type is rejected before BEGIN |
| options.timeoutMs | number | No / no | The provider's operationTimeoutMs, otherwise 30000 | An integer 1..2147483647; includes waiting for the reservation, BEGIN, the work and COMMIT |

Unknown options fields are not used; there are no conversions and no serialization.
The result is the callback value after a successful COMMIT; errors reject the Promise.

| Failure | Condition | Behavior |
| --- | --- | --- |
| TypeError | An invalid signal | Before calling the provider |
| OrmTransactionScopeError | The signal is already aborted | The callback and BEGIN do not run |
| OrmTransactionScopeError | A signal during the callback / while operations close | New operations are forbidden, rollback; unfinished SQL is cancelled with a confirmed rollback by the physical owner |
| ORM_TRANSACTION_OUTCOME_UNKNOWN | No proof of cancellation or COMMIT confirmation within the budget | DbUpdateError, phase=cancellation/commit; retries, fake callbacks and SQL of the affected contexts are forbidden |
| UniqueViolationError | SQLSTATE 23505 in saveChanges | DbUpdateError with constraint/table/cause; the driver's own errno/code are kept for outcome classification |
| Existing scope errors | A foreign provider, a stale scope, competing child scopes | The former behavior |

The signal is passed to reserve({ signal }); a connection handed out after cancellation
is closed without BEGIN. The provider bounds BEGIN, SQL and COMMIT with the same work
deadline; confirming a cancellation gets a separate finite budget. The listener of the
logical scope is removed before COMMIT, but the physical owner keeps tracking its
deadline. A lost COMMIT confirmation keeps phase=commit. After a confirmed COMMIT an
external cancellation does not change its outcome and does not cancel afterCommit. The
time of user afterCommit/afterRollback is not bounded by the work deadline. Releasing the
reservation gets a separate cancellationTimeoutMs; the whole call may take the work time,
the cancellation confirmation and cleanup, and then the callback time.
Cancellation in a nested scope rolls back the whole physical transaction, including in server mode with the connection kept.

### PostgreSQL provider and ORM connector settings

| Field | Default | Validation / responsibility |
| --- | --- | --- |
| operationTimeoutMs | 30000 | A positive integer, ms; root query/execute, the physical transaction and the ORM scope |
| cancellationMode | server | An optional `server` or `close`; null and other values are rejected before SQL is created. `close` explicitly enables the former close policy with proof that the backend is gone |
| cancellationTimeoutMs | 5000 | A positive integer, ms; confirming a cancellation and releasing the resource have finite budgets |
| maxPendingOperations | 256 | A positive integer; an unfinished native Promise holds a slot until its real settlement; cleanup has a reserve of up to twice the limit |
| serverTimeouts.statementTimeoutMs / lockTimeoutMs / idleInTransactionTimeoutMs / transactionTimeoutMs | Not set | Positive integers, ms; SET LOCAL and a readback at BEGIN; the last field needs PostgreSQL 17+ |
| onOperation | Not set | A callback with operation/outcome/durationMs/pendingNativeOperations; callback exceptions do not change the SQL result |
| statistics() | A snapshot | pendingNativeOperations, activeCancellations, unconfirmedCancellations, closed; no SQL and no secrets |

For optional numeric fields, absence means undefined; null, fractional, non-positive and
out-of-range values are rejected. `query(sql, params)` and `execute(sql, params)` keep
their inputs and results; root calls now reserve a connection for the operation.
`ping(signal?)` returns a boolean, including false on cancellation; `close()` takes no
arguments, is idempotent and forbids new operations.
`withRetry(provider).ping(signal?)` passes the same optional signal to the base provider
and keeps its boolean result without retries. An already aborted signal allows no SQL;
cancelling a pending connection keeps its release on a late handout. The checks use the
real PostgresProvider with a stub driver:
[orm.retry-ping.test.ts](test/orm.retry-ping.test.ts).
Root queries get a client deadline, but SET LOCAL and the exact backend identity for a
confirmed rollback are prepared inside transactionScope. A cancellation outside such a
scope may give a conservative unknown outcome.

For a root query/execute (autocommit), losing the response after the command was handed
to the driver returns ORM_TRANSACTION_OUTCOME_UNKNOWN, phase=commit. This applies to query
too: SQL may contain INSERT RETURNING or a function with side effects. The connection is
forbidden for reuse and closed; withRetry does not retry the SQL even if a user
isTransient returns true. A new context reconciles the result by a durable business key.
SQL is not parsed to guess idempotency; there are no new queries on the success path. A
confirmed ErrorResponse with an SQLSTATE is kept, except connection exception, shutdown and
40003, which do not prove the outcome. An admission error before dispatch keeps the former
semantics. The explicit transaction protocol and the COMMIT confirmation stay the same.
After a successful root query/execute, a reservation release error is returned as the
existing PostCommitError with committed=true: an automatic retry is also forbidden,
because the command result is already confirmed.

The onOperation event: operation=`query|execute|admission|cancellation`,
outcome=`success|error|unknown`, durationMs is the duration of the matching phase,
pendingNativeOperations is the number of its unfinished native operations on the provider.
`statistics()` without arguments returns an immutable snapshot: pendingNativeOperations
and activeCancellations are current counts; unconfirmedCancellations is an accumulated
counter of unknown cancellations; closed forbids new work. It is not a counter of live
PostgreSQL backends or connections and does not limit all user JS.

Extra `ormBazisConnect` configuration fields: max, connectionTimeout, idleTimeout,
maxLifetime, tls, tlsCa, operationTimeoutMs, cancellationTimeoutMs, cancellationMode,
maxPendingOperations and four flat server timeout fields. The first three Bun
connection/idle/lifetime timeouts are in seconds, the ORM/server ones in milliseconds.
Unspecified native settings keep the Bun behavior; the fields must be declared in the
domain defineConfig to get env overrides. Zero idleTimeout and maxLifetime are allowed.
tls takes the Bun modes; tlsCa is supported only with verify-full and becomes the checked
ca/serverName/rejectUnauthorized. The new type PostgresOrmConfigShape extends the former
PostgresConfigShape; the raw Infra connector stays a separate contract.
The full input contract of the integration: [core/orm](../../core/orm/MODULE.md).

A configuration change does not apply to an already created singleton. Migration and
owned-store admission scopes keep their own contracts; their whole lifecycle is not
declared bounded by the new transaction timeout. Arbitrary user callbacks cannot be
physically interrupted by JavaScript means.

## 6. Checks and the readiness boundary

Version 3: the normal hot path does not touch the control pool. A successful server
cancellation keeps the connection and the TLS session; the cost is up to one extra
connection per PostgresProvider and a few SQL statements on cancellation. Access/TLS
settings come from the same input as the working connection. There are no new
dependencies; the qualification uses the same code from bun:test and a built binary.
[Integration results](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-server-cancel-integration-2026-09-14.md).

SQL pg_cancel_backend takes a PID, not the PID+secret of the CancelRequest protocol.
Checking pg_stat_activity and sending the signal are not atomic against the system
reusing the PID. This limit is not declared removed; failover, PgBouncer, other server
topologies and client platforms need a separate qualification. If this limit is not
acceptable, the explicit close mode with its known limits is available. This change does
not fix Bun's native Query.cancel.

The following results refer to the former close policy and stay valid for
`cancellationMode: "close"`; this is a test history, not the status of the server mode.

Version 2: the final unknown outcome was checked with a blackhole, a server restart, a
lost COMMIT response and a closed TLS connection. With a lost COMMIT an independent read
confirmed the saved row; there were no automatic retries and no callbacks.
The built ORM binary was checked from /tmp with plain TCP, TLS unknown and TLS with an
explicitly set statement timeout. Exact results and the current typecheck are in the
[version 2 report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-bun-sql-hardening-2026-09-14.md).

**TLS fast cancellation: FAIL.** The native session.close({timeout:0}) finished, but
PostgreSQL kept running the active SQL. In the strict binary scenario the backend stayed
active after 5 seconds, and the ORM returned unknown. In a separate check with a server
statementTimeoutMs=600 the confirmed rollback took 641 ms; this is a profile of bounding
SQL duration, not a fix of the native cancel defect and not a universal time from abort.
A trusted CA/hostname are checked; a wrong hostname is rejected.

The version 1 results for plain TCP are kept below; they are not evidence for TLS:

| Check | Result | Evidence / limit |
| --- | --- | --- |
| Cancelling active SQL | PASS | 8 scope × query/execute combinations, the server confirmed the SQL before cancellation, completion in 395–402 ms |
| Other cancellation limits on PostgreSQL | PASS | 6 scenarios: callback exit, parent signal, a neighboring query, pre-abort, queue max=1, timeout / afterCommit |
| Earlier physical scenarios and load | PASS | 44 tests, 800 transactions, 12 000 rows; two guards for the missing opt-in env were skipped because it was set |
| Unit and types | Results in the report | Checks run through the pinned wrapper with a cleaned live environment |

Exact commands, logs, hashes and final counters:
[fix report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-2026-09-14-cancellation-fix.md).
The native `Bun.SQL Query.cancel()` stays a separate failed upstream gate:
[earlier qualification](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-2026-09-14-qualification.md).
The change does not update the toolchain and does not claim a fix of Bun itself.

## 8. Typed conditions (DX, 2026-10-02)

An extra passport scope: Query/conditions.ts and the column selection contracts of
Query/ImmediateMutations.ts. These are components of the existing ORM; no new modules,
registrations or runtime dependencies were added. The Operand<T> type keeps the model
field type; FieldSelector<T> returns such operands, eq/ne/in check values, string
operations are available only for strings, ordered comparisons for string/number/
bigint/Date. Choosing a column for sorting and conflictBy depends only on the property;
the runtime check that conflictBy belongs to the current proxy is kept.

Codegen uses the shared TypeScript Program, analyzes the Predicate type and rejects `&&`,
`||`, `!` and conditional branches on a predicate with the code BAZIS_ORM_PREDICATE_LOGIC,
the file and the position. The correct input:
`u => u.age.gte(18).and(u.name.startsWith("A"))`. The public SQL and save semantics do
not change. The check costs generation time; the runtime query does not parse source
code. No new performance guarantees are claimed.

The guarantee boundary: the chosen codegen target and the available TypeScript
information. JavaScript, any and a manual run without generation must follow
.and/.or/.not; no runtime protection from JS truthiness is claimed.

Checks: [types and diagnostics](../../core/scripts/test/orm-predicate-codegen.test.ts),
[the real pipeline and keeping earlier outputs](../../core/scripts/test/codegen-dx.integration.test.ts),
[the existing immediate mutation contracts](test/orm.immediate-mutations-v1.test.ts).
The physical transaction/server checks from the previous sections were not rerun by
this change.

## 9. Branched include (2026-10-02)

`Query/IncludeLoader.ts` stays an internal component of the existing atomic ORM. The
`include(selector)`, `thenInclude(selector)` and `asNoTracking()` inputs did not change.
Within one query execution each shared path prefix is loaded once and keeps the received
instances for all its branches. This applies to reference and collection, including an
empty result; an already loaded branch is not replaced with new instances under
`asNoTracking()`. The order of first appearance of paths and the existing SQL splitting by
the parameter limit are kept. A read error still rejects the whole query.

The cache belongs to one `IncludeLoader.load` call, is not kept between reads and does
not replace the ChangeTracker. There are no new public types, DI registrations, tables or
migrations. The branches `children.leaves` and `children.note` in an isolated fixture run
four SELECTs together with the root instead of the former five; this measures the number
of queries, not a latency promise under load.

Checks: [orm.include-branches.test.ts](test/orm.include-branches.test.ts):
reference/collection, both tracking modes, both branch orders, a repeated and an empty
prefix, a repeated execution with new data. The real ORM with a stub read-only provider
is used; physical PostgreSQL and the binary build are not qualified by this check.
A separate [physical regression](../../core/orm/test/orm.release-095.postgres.live.test.ts)
checks the same eight combinations on its own PostgreSQL tables. Its guard and dedicated
URL are described in the [core/orm passport](../../core/orm/MODULE.md).

## 10. Canonical entity instance (2026-10-04)

The existing atomic ORM keeps one instance of a saved entity per "model, primary key"
pair. `ChangeTracker` checks this invariant, and `SaveExecutor` checks the whole key set
before SQL and again after `RETURNING`, inside the transaction, before accepting any new
snapshot. The `add`, `attach`, `update`, `remove`, `saveChanges` inputs and the public
types did not change.

Attaching another object with the key of an already tracked entity gives `DbUpdateError`
before the tracker changes. The key value is not included in the error.
Change the instance you got earlier; for a truly detached object use a context where
this key is not tracked yet. Repeating an operation on the same instance stays allowed.

Manual `Added` keys can be assigned after `add`. Such records are not indexed until
saving; a conflict between them or with a later `attach` is rejected on `saveChanges`
before the first SQL. This keeps the set check linear and allows adding several objects
that are not filled in yet. For generated keys, equal initial values, including `0`, are
treated as temporary; the final keys from `RETURNING` are checked. A conflict rolls back
the transaction and restores the original keys and states of all records.

A deletion saved inside an outer transaction stays provisional: until it ends the key is
held for the former instance, even if it is no longer visible in the regular tracker.
Otherwise a rollback could not restore the record without a conflict with a new object.
The hold is released on commit or rollback. Deleting and re-adding the same instance in
one transaction is allowed; replacing it with another object with the same key is allowed
after commit. Before, replacing it inside an outer transaction left no consistent tracker
state on rollback.

Internal tracker completion handlers are marked with a private `WeakSet`.
`runPostCommitCallbacks` runs them after a confirmed COMMIT, before the public
`afterCommit`; the relative order of public handlers is kept. An error of one handler does
not skip the others and stays a `PostCommitError`. This path is not called on rollback and
on an unknown outcome.

Checks through the public `DbContext`:
[orm.identity-map.test.ts](test/orm.identity-map.test.ts): an atomic rejection,
manual/composite/generated keys, several initial `0`, a conflict of all `RETURNING` rows
before commit, outer rollbacks, releasing the key after commit and re-adding the former
instance. SQL is stubbed; the checks do not replace physical PostgreSQL qualification.

## 11. Native JSONB values (2026-10-04)

`PostgresDialect` works with native Bun.SQL values: JSON strings, numbers, booleans,
arrays and objects are already parsed by the driver after reading.
There is no second `JSON.parse`: the JSON strings `"123"`, `"false"`, `"null"` and
`"{\"role\":\"reader\"}"` keep their string type both in an entity and in a projection.
`null` still represents a missing value.

On write, Bun 1.4.0 binds a bare number/boolean as an SQL number/boolean, which
PostgreSQL rejects when assigning to JSONB. Only for these two JSON types the dialect
creates a frozen internal object with `toJSON` returning the original scalar. The driver
picks the JSON binding and serializes it itself. Native strings, arrays and objects are
passed the former way: a prior `JSON.stringify` would encode them twice.

`ImmediateMutations` keeps this object without copying only after checking that it
belongs to the dialect's private `WeakSet`. It holds only an immutable number/boolean;
user functions, `toJSON`, getters and fake results of an arbitrary dialect stay forbidden
by the existing input check. There are no new public APIs, parameter types, SQL casts,
DI registrations or application tables.

Checks: [orm.json-native.test.ts](test/orm.json-native.test.ts) covers reading 17 values,
`saveChanges`, `executeUpdate`, `insertIfAbsent` and keeping the rejection of foreign
`toJSON` without calling user code.
[orm.json-native.postgres.live.test.ts](test/orm.json-native.postgres.live.test.ts)
checks a PostgreSQL entity/projection, INSERT/UPDATE through fresh contexts and the
immediate operations. The physical test is enabled only with
`BAZIS_ORM_JSON_NATIVE_LIVE=1` and `BAZIS_PG_URL`: the `orm_json_native` database, the address
`127.0.0.1`, a separate explicitly set port other than `5432`. It creates and drops only
its own random schema. The test's existence and its skip without the opt-in env are
not a successful physical check; the results of a specific run are recorded separately
in the repeated audit report.

## 12. UUID v7 keys (2026-10-05)

`@UUID({ version: "v7" })` and a dynamic-table key `{ type: "uuid", isKey: true,
uuidVersion: "v7" }` compile to `KeyGeneration` `uuidV7`. Before this change
the decorator option was rejected at model build, and the dynamic table
silently got a v4 database default.

The ORM assigns `Bun.randomUUIDv7()` in `applyConventions` to an `Added` entity
whose key is unset (`undefined`, `null` or `""`); a key set by the application
is kept. INSERT sends the key as a parameter without `RETURNING`. The column
is a native `uuid NOT NULL` primary key without a default, so the contract does
not depend on the PostgreSQL 18 `uuidv7()` function. Foreign keys to the key get
the `uuid` physical type as for v4 keys.

`isDatabaseGenerated(generation)` in `Metadata/types.ts` is the single rule for
"the database assigns the key"; `CommandBuilder`, `SaveExecutor` and
`ChangeTracker` use it, so a v7 key is treated as an application key. The
duplicate-key preflight skips only unassigned v7 keys and rechecks after the
ORM assigns them. `insertIfAbsent` keeps its contract: it inserts the given
values and does not apply conventions.

Owned-store admission accepts a `uuid` column either as a single v4 key with
`uuidDefault` generation and the `gen_random_uuid()` default, or as a plain
column without generation and without a default (`DEFAULT NULL` for a nullable
column). The second form covers v7 keys and foreign keys to uuid keys; before
2026-10-06 admission rejected it with `ORM_OWNED_STORE_IDENTITY_MISMATCH`.

Checks: [orm.uuid-v7.test.ts](test/orm.uuid-v7.test.ts) (model, DDL, expected
schema, assignment, kept and duplicate keys, dynamic tables) and
[orm.uuid-v7.postgres.live.test.ts](test/orm.uuid-v7.postgres.live.test.ts)
(`ensureCreated` and its replay, native `uuid` columns without defaults, a
foreign key, a round trip through a fresh context). The live test passed on
PostgreSQL 17 and 15.7 in throwaway local containers, together with the
existing `orm.ensure-created.postgres.live.test.ts` on 15.7.
[orm.owned-store.uuid-v7.postgres.live.test.ts](../../core/orm/test/orm.owned-store.uuid-v7.postgres.live.test.ts)
covers an owned store with a v7 key and a uuid foreign key (admission, saving,
exact replay); it runs only against a dedicated `bazis_v7_*` database with
`BAZIS_OWNED_STORE_V7_LIVE=1`. It passed on PostgreSQL 17 in a throwaway local
container, together with the existing `orm.owned-store.core.postgres.live.test.ts`.
