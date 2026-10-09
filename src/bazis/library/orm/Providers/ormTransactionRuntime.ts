import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseProvider, DbExecutor, ExecuteResult, Row, SchemaAdmissionScope } from "./types";
import { knownExecutionStrategyBase } from "../Saving/ExecutionStrategy";
import type { OrmTransactionScopeOptions, OrmDatabaseTimeV1 } from "../Transactions/OrmTransaction";

export type TransactionOperationObserver = <T>(operation: () => Promise<T>) => Promise<T>;

function observedExecutor(executor: DbExecutor, observe: TransactionOperationObserver): DbExecutor {
  return {
    query: (sql, params) => observe(() => executor.query(sql, params)),
    execute: (sql, params) => observe(() => executor.execute(sql, params)),
  };
}
export interface CancellableProviderDispatch { cancel(): unknown; readonly settled: Promise<unknown>; }
export type ProviderDispatchObserver = (dispatch: CancellableProviderDispatch) => void;
const dispatchObservers = new AsyncLocalStorage<ProviderDispatchObserver>();

/** Private ALS bridge used only by provider implementations and the coordinator. */
export function withProviderDispatchObserver<T>(observer: ProviderDispatchObserver, work: () => T): T {
  return dispatchObservers.run(observer, work);
}
export function withoutProviderDispatchObserver<T>(work: () => T): T { return dispatchObservers.exit(work); }
export function observeProviderDispatch(dispatch: CancellableProviderDispatch): void { dispatchObservers.getStore()?.(dispatch); }

const ROOTS = new WeakMap<DatabaseProvider, object>();
const scopeOptions = new AsyncLocalStorage<OrmTransactionScopeOptions>();
export function withPostgresScopeOptions<T>(options: OrmTransactionScopeOptions, work: () => T): T { return scopeOptions.run(options, work); }
export function withoutPostgresScopeOptions<T>(work: () => T): T { return scopeOptions.exit(work); }
export function currentPostgresScopeOptions(): OrmTransactionScopeOptions | undefined { return scopeOptions.getStore(); }

interface PostgresTransactionCapability {
  readonly operationTimeoutMs?: number;
  readonly isOutcomeUncertain?: (error: unknown) => boolean;
  readonly operationSignal?: () => AbortSignal | undefined;
  readonly databaseTime: () => Promise<OrmDatabaseTimeV1>;
  readonly assertScopedClose: () => void | Promise<void>;
  readonly quarantine: () => Promise<void>;
  /** The physical owner settles cancellation and rollback itself; the
   * coordinator must not rely on native Query.cancel or a timed drain. */
  readonly quarantineOnPendingDispatch?: boolean;
}
const POSTGRES_CAPABILITIES = new WeakMap<DatabaseProvider, PostgresTransactionCapability>();

/** Private registration: PostgreSQL exposes no transaction internals in DatabaseProvider. */
export function registerPostgresTransactionCapability(provider: DatabaseProvider, capability: PostgresTransactionCapability): void {
  POSTGRES_CAPABILITIES.set(provider, capability);
}

export function postgresTransactionCapability(provider: DatabaseProvider): PostgresTransactionCapability | undefined {
  const base = baseProvider(provider);
  return base ? POSTGRES_CAPABILITIES.get(base) : undefined;
}

/** Private identity is deliberately object identity, never connection settings. */
export function rootAuthority(provider: DatabaseProvider): object {
  const base = knownExecutionStrategyBase(provider) ?? provider;
  let authority = ROOTS.get(base);
  if (!authority) {
    authority = {};
    ROOTS.set(base, authority);
  }
  return authority;
}

export function baseProvider(provider: DatabaseProvider): DatabaseProvider | undefined {
  return knownExecutionStrategyBase(provider);
}

/** Explicit proxy preserves prototype-owned provider methods without object spread. */
export function createObservedProvider(provider: DatabaseProvider, observe: TransactionOperationObserver, capture?: () => TransactionOperationObserver): DatabaseProvider {
  const schema = provider.schemaAdmissionCapability;
  const fenceSchemaScope = (scope: SchemaAdmissionScope): SchemaAdmissionScope => {
    const scopedObserve = capture?.() ?? observe;
    const executor = observedExecutor(scope, scopedObserve);
    const privateScope = scope as SchemaAdmissionScope & { executeSchemaAdmission?: (sql: string, operation: string) => Promise<ExecuteResult> };
    const result: SchemaAdmissionScope & { executeSchemaAdmission?: (sql: string, operation: string) => Promise<ExecuteResult> } = {
      query: executor.query,
      execute: executor.execute,
      introspectExpected: (expected) => scopedObserve(() => scope.introspectExpected(expected)),
    };
    if (privateScope.executeSchemaAdmission) {
      result.executeSchemaAdmission = (sql, operation) => scopedObserve(() => privateScope.executeSchemaAdmission!(sql, operation));
    }
    return result;
  };
  const result = {
    name: provider.name,
    dialect: provider.dialect,
    limits: provider.limits,
    diagnostics: provider.diagnostics?.bind(provider),
    query: (sql, params): Promise<Row[]> => observe(() => provider.query(sql, params)),
    execute: (sql, params): Promise<ExecuteResult> => observe(() => provider.execute(sql, params)),
    transaction: (work): Promise<unknown> => observe(() => provider.transaction((executor) => work(observedExecutor(executor, capture?.() ?? observe)))),
    transactionScope: provider.transactionScope ? (work): Promise<unknown> => observe(() => provider.transactionScope!((executor) => work(observedExecutor(executor, capture?.() ?? observe)))) : undefined,
    isTransactionActive: provider.isTransactionActive?.bind(provider),
    afterCommit: provider.afterCommit?.bind(provider),
    afterRollback: provider.afterRollback?.bind(provider),
    ping: (signal?: AbortSignal): Promise<boolean> => observe(() => provider.ping(signal)),
    probe: provider.probe ? (signal?: AbortSignal): Promise<void> => observe(() => provider.probe!(signal)) : undefined,
    introspect: () => observe(() => provider.introspect()),
    schemaAdmissionCapability: schema ? {
      version: schema.version,
      provider: schema.provider,
      distributedLock: schema.distributedLock,
      transactionalDdl: schema.transactionalDdl,
      exactIntrospection: schema.exactIntrospection,
      withSchemaAdmission: (schemas, work) => observe(() => schema.withSchemaAdmission(schemas, (scope) => work(fenceSchemaScope(scope)))),
    } : undefined,
    withMigrationLock: provider.withMigrationLock ? (work) => observe(() => provider.withMigrationLock!(() => observe(work))) : undefined,
    listen: provider.listen ? (channel, handler) => observe(() => provider.listen!(channel, handler)) : undefined,
    notify: provider.notify ? (channel, payload) => observe(() => provider.notify!(channel, payload)) : undefined,
    // A transaction view must never own, and therefore never close, the root pool.
    close: () => provider.close(),
  } as DatabaseProvider;
  const base = baseProvider(provider);
  if (base) ROOTS.set(result, rootAuthority(base));
  return result;
}
