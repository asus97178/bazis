import type { DbContext } from "../DbContext";

/** A database wall-clock value obtained from the active database session. */
export interface OrmDatabaseTimeV1 {
  readonly instant: Date;
  readonly epochMilliseconds: number;
  readonly precision: "millisecond";
}

/** Bounded scope work, including reservation admission and physical COMMIT.
 * Cancellation cleanup has the provider's separate finite budget. A COMMIT
 * without acknowledgement reports an unknown outcome; afterCommit is user
 * work after a confirmed commit and is not undone by a late abort. */
export interface OrmTransactionScopeOptions {
  readonly signal?: AbortSignal;
  /** Total work budget in milliseconds, including admission and COMMIT; positive integer. */
  readonly timeoutMs?: number;
}

/** Opaque transaction capability. It deliberately exposes no executor or completion authority. */
export abstract class OrmTransaction {
  abstract use<TContext extends DbContext, TResult>(
    context: TContext,
    work: (context: TContext) => Promise<TResult>,
  ): Promise<TResult>;

  abstract databaseTime(): Promise<OrmDatabaseTimeV1>;

  abstract afterCommit(callback: () => void | Promise<void>): void;
}
