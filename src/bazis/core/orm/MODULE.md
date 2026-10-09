# ORM: connection and operational policy

Version: 5. Check date: 2026-10-02.
Type: the existing atomic integration of the library ORM with DI and Infra.
Scope of this passport: the extra `ormBazisConnect` inputs and passing the
lifecycle/health signal. The other `ormModule` contracts are kept.

`databaseConnector.ts` gets an `AppConfig<PostgresOrmConfigShape>` declaration;
with a `ConfigRegistry` it reads the current kernel's view through `reader`.
The configuration declaration is not mutated. The shared Infra
`postgresConnectionOptions` checks the main connection parameters. The extra policy
belongs to the ORM connector. There are no new modules or DI registrations.

The connector creates one `PostgresProvider`, publishes it under `DATABASE_PROVIDER`,
connects in phase −110 and closes it at shutdown. The `connect` and `healthCheck`
signal is passed to `provider.ping(signal)`. An unavailable database gives `false`
in health and `InfraError` while connecting. On close the provider forbids new work.
The `ormModule` factory and feature contexts keep using the shared provider.

## Startup plan check (D2, 2026-10-02)

`OrmHostedPlan.validator.ts` owns the conflicts of phases/table owners/FKs and the
incompatibility with legacy admission. OrmLifecycle, OrmOwnedStoreLifecycle and the
provider lifecycle expose it through the shared `HostedService.planValidator`,
including manual composition. The Kernel runs the check before any onInit/start.
No new options or separate DI registrations are needed; the existing error codes
and phases are kept. One stateless object checks the whole plan once and owns no database.
`strictSchemaHostedIdentity.ts` owns the ORM-specific rules: the shared DB slot
must provide the same DATABASE_PROVIDER DI token and phase −110. For LLM and
checkpoint protection, phase −100 is allowed only with an unchanged factory identity.
Regular internal ORM lifecycles keep their existing markers.
The shared mechanism that binds a connector to its lifecycle lives in Infra and does
not import the ORM; the ORM reads its information without changing connection
ownership. Copies of the lifecycle, copies/subclasses of the connector and replaced
fields of it do not gain the permission.
The internal identity functions are not exported by public facades.
The DB slot checks now live with the policy owner:
[orm.infra.test.ts](test/orm.infra.test.ts). They check legacy strict and owned-store
plans, rejection before a client is created and the reverse shutdown order.

By the owner's decision of 2026-10-02 the `kind` marker was removed from
InfraConnector and the ORM checks. A custom connector with the DatabaseProvider
contract is admitted on the same terms as the built-in one: the shared token and a
connection in phase −110. The manifest entry name does not affect admission. Another
token, even one named `DatabaseProvider`, does not replace the shared one. A
connection error stops startup before schema admission and application services;
the created resource is released once.
The owned-store, strict admission and private LLM/protector identity checks are kept.

## Input fields

All extra fields below are optional, and `null` is not allowed. The source is the
application's declared configuration and its view for the current kernel. Declare the
fields in `defineConfig` so typed env overrides work.
Keys unknown to the connector are ignored; the connector does not convert strings to numbers.
A wrong known field raises `InfraError` before the SQL client is created.

| Field | Type / unit / allowed values | When absent |
| --- | --- | --- |
| host, port, database, username, password | The original `PostgresConfigShape`; the password is a `Secret` | The existing required fields |
| max | Integer 1..2147483647, connections | Bun setting |
| connectionTimeout | Integer 1..2147483647, seconds | Bun setting |
| idleTimeout, maxLifetime | Integer 0..2147483647, seconds; 0 turns off the matching native limit | Bun setting |
| tls | `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full` | Bun setting |
| tlsCa | PEM text; non-empty only with `tls=verify-full`. An empty string means no CA: `defineConfig` cannot express optional keys (2026-10-04) | No extra CA |
| operationTimeoutMs | Integer 1..2147483647, ms | 30000 |
| cancellationMode | `server` or `close` | Server cancellation; one extra lazy control pool max=1 |
| cancellationTimeoutMs | Integer 1..2147483647, ms | 5000 |
| maxPendingOperations | Integer 1..2147483647, unfinished native operations | 256 |
| statementTimeoutMs | Integer 1..2147483647, ms; `statement_timeout` | Unchanged |
| lockTimeoutMs | Integer 1..2147483647, ms; `lock_timeout` | Unchanged |
| idleInTransactionTimeoutMs | Integer 1..2147483647, ms; `idle_in_transaction_session_timeout` | Unchanged |
| transactionTimeoutMs | Integer 1..2147483647, ms; `transaction_timeout`, PostgreSQL 17+ | Unchanged |

`tlsCa` is passed as `ca`, the host as `serverName`, and certificate verification
is enabled with `rejectUnauthorized: true`. Pool/connection/TLS values go to the
Bun.SQL options; the server timeout fields go to the provider's `serverTimeouts`.
cancellationMode is passed to the library provider; the control pool's TLS and
credentials match the working pool, and both are closed on dispose. The SET LOCAL
profile is applied and checked inside the transaction after BEGIN; it is not a
global server setting and not a deadline of the migration lifecycle.

An example of extra fields inside an existing dbConfig declaration (the values are
illustrative; align them with the application's query durations):

```ts
max: 10,
connectionTimeout: 5,       // Bun seconds
idleTimeout: 30,
maxLifetime: 1800,
tls: "verify-full",
operationTimeoutMs: 10_000,
cancellationTimeoutMs: 2_000,
maxPendingOperations: 256,
statementTimeoutMs: 8_000,
lockTimeoutMs: 1_000,
idleInTransactionTimeoutMs: 10_000,
transactionTimeoutMs: 15_000, // PostgreSQL 17+
```

The settings apply when the provider is created; a singleton that is already running
is not reconfigured. No new tables, migrations, HTTP/AI/UI inputs or background
handlers are added. The public TypeScript type `PostgresOrmConfigShape` is exported
from `core/orm/index.ts`; the private runtime policy is not exported.

## Checks and limits

`test/orm.connection-policy.test.ts` checks invalid fields and the passing of the
operation timeout and the health signal. Physical scenarios, binary execution and the
TLS check are described in the [implementation report](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-bun-sql-hardening-2026-09-14.md).
Types and final results always come from the report's latest receipt.

Server cancellation through a separate Bun.SQL connection is on by default;
[its qualification](https://github.com/asus97178/osnova/blob/33a4513a56abb43a1694e7a6e56373187b928a70/docs/audits/orm-server-cancel-integration-2026-09-14.md)
is separate from the old close mode. Direct fast cancellation by closing TLS on the
qualified Bun 1.4.0 still fails:
closing a native Promise does not guarantee that SQL stops on the server at once.
The contract of the final unknown outcome, the timeouts and the retry ban are defined
in the [library ORM passport](../../library/orm/MODULE.md). `statement_timeout`
bounds SQL execution from its start, not the time after an arbitrary abort.

## Save boundary (DX, 2026-10-02)

IRepository<T> addresses one entity, but saveChanges() still saves all changes of
its DbContext. The method contracts and the transactional semantics are kept. New
application services and CLI templates use an explicit DbContext with DbSet and
db.saveChanges(), without an extra Unit of Work.
The getAll of the CLI templates returns the existing PageResult<T>
(items, total); HTTP controllers are responsible for JSON:API. paginate did not
change: a count and a bounded SELECT, keys for a stable order, max limit 1000.

## ListQuery filter values (2026-10-02)

`listQuery.ts` belongs to the existing atomic ORM integration. The public
`paginate(query, list): Promise<PageResult>` entry and the `ListQuery` structure
are kept: `filters[].field/op/value` and the same rules in `or[][]` come from the
parser with allow lists of fields and operators; value is a string or an array of
strings for `in`/`nin`. The conversion now uses the `PropertyModel.type` of the
chosen column, not a type guessed from how the string looks.

For `text`, the values `0012`, `000.50`, `9007199254740993` stay exact strings in
comparisons and lists. For `integer`/`real`, decimal numeric strings become
numbers; integers outside the JavaScript safe range become bigint for integer.
For `boolean`, `true`/`false` and the existing numeric values `0`/`1` are kept.
`datetime`/`json` are passed as strings to the existing converter/dialect.
The unknown column check stays in the ORM compiler. No new HTTP validation of
values was added: unsuitable values and storage ranges are still handled by the
existing converter, dialect and provider.

SQL stays parameterized; `count` and the page query get the same conditions.
[orm.listQuery.test.ts](test/orm.listQuery.test.ts) checks the compiled PostgreSQL
parameters for scalar/in/nin/OR, text, numeric and boolean, including bigint. These
are provider-independent tests without a physical database; they do not claim the
filter was checked on PostgreSQL or in a binary.

The [physical regression](test/orm.release-095.postgres.live.test.ts) is meant
only for a throwaway PostgreSQL: `BAZIS_RELEASE_095_PG=owned-disposable-v1`,
`BAZIS_RELEASE_095_PG_URL` with `127.0.0.1`, an explicit port other than 5432 and the
`bazis_release_095` database. The test creates a unique `release_095_<uuid>` schema
and its own tables, checks the actual query and drops only this schema in `finally`.
A regular run without the guard gives SKIP and does not confirm physical qualification.

## Startup connection error (2026-10-09, 0.98.12)

`ormBazisConnect` checks the database at start with the provider's optional `probe(signal)`,
which rejects with the driver's error (`PostgresProvider` implements it; `ping` uses it and
keeps returning a boolean for health checks). The startup error names the target and the
reason, never the password: `Infra connector "database": cannot connect to PostgreSQL at
db:5432 (database "app", user "app"): password authentication failed for user "app"
(28P01)`. A provider without `probe` keeps the boolean check and names the target.
Before 0.98.12 every failure was `postgres is not reachable.`
Regression: [test/orm.infra.test.ts](test/orm.infra.test.ts).

## Primary key name drift in ensureCreated (2026-10-10, 0.98.13)

Exact admission (`ensureCreated` on PostgreSQL) tolerates one difference: a primary key that
differs from the model only by name (`tasks_pkey` from a schema created by an older version,
the model's `pk_tasks`). Columns and order of the key are still verified exactly. The table is
not renamed; `DatabaseFacade.ensureCreated()` returns `{ warnings }` and `OrmLifecycle` prints
`[orm:schema] table "public"."tasks": primary key is named "tasks_pkey", the model expects
"pk_tasks". It works as is; to align the name run: ALTER TABLE … RENAME CONSTRAINT …;`.
Queries never use the key name (`ON CONFLICT` names columns), and `migrateOnStart` already
accepted such tables, so both modes now agree. Owned-store catalogs keep exact names.
Regression: `library/orm/test/orm.ensure-created.postgres.live.test.ts` (needs `BAZIS_PG_URL`).

## Column type vs initial value (2026-10-10, 0.98.14)

`ModelBuilder` instantiates the entity once (`new ctor()`; a throwing constructor skips the
check) and compares each property without an explicit `type`, convention or converter with
its initial value. Without a type a column maps to `text` and a key to an integer identity;
a number, boolean, `Date`, object or array initial value on a column, or a non-number on a
key, now fails the model build and names the type to set. Before 0.98.14 such columns were
silently `text` (a number came back as a string) and a string key became a bigint identity
that dropped the assigned value. Regression: `library/orm/test/orm.column-type-initializer.test.ts`.
