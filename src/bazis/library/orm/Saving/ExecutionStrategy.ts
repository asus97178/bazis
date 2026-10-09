import type { DatabaseProvider } from "../Providers/types";
import { isCommittedOutcome } from "../errors";
import { isUnknownTransactionOutcome } from "../Providers/transactionOutcome";

const EXECUTION_STRATEGY_BASE_PROVIDERS = new WeakMap<DatabaseProvider, DatabaseProvider>();

/** Private bounded unwrap for framework ownership checks. */
export function knownExecutionStrategyBase(provider: DatabaseProvider): DatabaseProvider | undefined {
  let current = provider;
  const seen = new Set<DatabaseProvider>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const inner = EXECUTION_STRATEGY_BASE_PROVIDERS.get(current);
    if (!inner) return current;
    current = inner;
  }
  return undefined;
}

/** Options of the retry strategy for transient database errors. */
export interface ExecutionStrategyOptions {
  /** Maximum retries after the first failure (default 3). */
  readonly maxRetries?: number;
  /** Base delay between attempts, ms (exponential backoff). */
  readonly baseDelayMs?: number;
  /** Tells whether an error is transient and worth retrying. */
  readonly isTransient?: (error: unknown) => boolean;
}

/**
 * Execution strategy with retries (the counterpart of EF `EnableRetryOnFailure`).
 * Wraps SaveChanges and can be used for user transactions.
 */
export class ExecutionStrategy {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly isTransient: (error: unknown) => boolean;

  constructor(options: ExecutionStrategyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 50;
    this.isTransient = options.isTransient ?? ExecutionStrategy.defaultIsTransient;
  }

  static defaultIsTransient(error: unknown): boolean {
    if (isUnknownTransactionOutcome(error) || isCommittedOutcome(error)) return false;
    const message = error instanceof Error ? error.message : String(error);
    if (/ECONNRESET|ETIMEDOUT|connection terminated|deadlock detected|could not serialize|40001|08006|57P01/i.test(message)) {
      return true;
    }
    const code = (error as { code?: string } | null | undefined)?.code;
    if (code === "ERR_POSTGRES_CONNECTION_CLOSED") {
      return true;
    }
    return false;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        if (isCommittedOutcome(error) || isUnknownTransactionOutcome(error) || attempt >= this.maxRetries || !this.isTransient(error)) {
          throw error;
        }
        const delay = this.baseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
      }
    }
  }
}

/** Provider wrapper with retries on every execute/query (optional). */
export function withRetry(provider: DatabaseProvider, options?: ExecutionStrategyOptions): DatabaseProvider {
  const strategy = new ExecutionStrategy(options);
  const transactionScope = provider.transactionScope?.bind(provider);
  const isTransactionActive = provider.isTransactionActive?.bind(provider);
  const retryOnlyWhenKnownTopLevel = <T>(operation: () => Promise<T>): Promise<T> => {
    // Retrying one statement or callback inside an ambient transaction can
    // replay it after partial writes on the same physical transaction. Custom
    // providers without an activity probe are treated conservatively as well.
    return isTransactionActive?.() === false
      ? strategy.execute(operation)
      : Promise.resolve().then(operation);
  };
  // Explicit delegation: a `{...provider}` spread would lose the class methods
  // (they live on the prototype), leaving the wrapper without ping/introspect/close.
  const wrapped: DatabaseProvider = {
    name: provider.name,
    dialect: provider.dialect,
    limits: provider.limits,
    diagnostics: provider.diagnostics ? () => provider.diagnostics!() : undefined,
    query: (sql, params) => retryOnlyWhenKnownTopLevel(() => provider.query(sql, params)),
    execute: (sql, params) => retryOnlyWhenKnownTopLevel(() => provider.execute(sql, params)),
    transaction: (work) => retryOnlyWhenKnownTopLevel(() => provider.transaction(work)),
    transactionScope: transactionScope
      ? (work) => retryOnlyWhenKnownTopLevel(() => transactionScope(work))
      : undefined,
    isTransactionActive: isTransactionActive ? () => isTransactionActive() : undefined,
    afterCommit: provider.afterCommit ? (callback) => provider.afterCommit!(callback) : undefined,
    afterRollback: provider.afterRollback ? (callback) => provider.afterRollback!(callback) : undefined,
    ping: (signal) => provider.ping(signal),
    probe: provider.probe ? (signal) => provider.probe!(signal) : undefined,
    introspect: () => provider.introspect(),
    schemaAdmissionCapability: provider.schemaAdmissionCapability,
    withMigrationLock: provider.withMigrationLock ? (work) => provider.withMigrationLock!(work) : undefined,
    listen: provider.listen ? (channel, handler) => provider.listen!(channel, handler) : undefined,
    notify: provider.notify ? (channel, payload) => provider.notify!(channel, payload) : undefined,
    close: () => provider.close(),
  };
  EXECUTION_STRATEGY_BASE_PROVIDERS.set(wrapped, provider);
  return wrapped;
}

/** Lets a subsystem with its own bounded whole-command retry policy avoid nested retries. */
export function withoutExecutionStrategyRetries(provider: DatabaseProvider): DatabaseProvider {
  let current = provider;
  const seen = new Set<DatabaseProvider>();
  while (!seen.has(current)) {
    seen.add(current);
    const inner = EXECUTION_STRATEGY_BASE_PROVIDERS.get(current);
    if (inner === undefined) return current;
    current = inner;
  }
  return current;
}
