import { ConcurrentTransactionScopeError } from "../errors";
import type { AfterCommitCallback, TransactionCallback } from "./types";

/** Callback frame owned by one top-level transaction or nested savepoint. */
export interface TransactionCallbackScope {
  readonly afterCommit: AfterCommitCallback[];
  readonly afterRollback: TransactionCallback[];
  readonly parent?: TransactionCallbackScope;
  activeChild?: symbol;
  rollbackOnly?: unknown;
}

export interface ChildTransactionScope {
  readonly callbacks: TransactionCallbackScope;
  readonly ownership: symbol;
}

export function createTransactionCallbackScope(
  parent?: TransactionCallbackScope,
): TransactionCallbackScope {
  return {
    afterCommit: [],
    afterRollback: [],
    ...(parent === undefined ? {} : { parent }),
  };
}

/**
 * Claims the parent's single connection/savepoint stack synchronously. Nested
 * scopes are still allowed because they receive their own callback frame.
 */
export function beginChildTransactionScope(parent: TransactionCallbackScope): ChildTransactionScope {
  if (parent.activeChild !== undefined) {
    throw new ConcurrentTransactionScopeError();
  }
  const ownership = Symbol("osnv.transaction-scope");
  parent.activeChild = ownership;
  return { callbacks: createTransactionCallbackScope(parent), ownership };
}

export function endChildTransactionScope(
  parent: TransactionCallbackScope,
  ownership: symbol,
): void {
  if (parent.activeChild === ownership) {
    parent.activeChild = undefined;
  }
}

/** Successful savepoint release makes its callbacks part of the parent. */
export function mergeTransactionScopeCallbacks(
  parent: TransactionCallbackScope,
  child: TransactionCallbackScope,
): void {
  parent.afterCommit.push(...child.afterCommit);
  parent.afterRollback.push(...child.afterRollback);
  if (child.rollbackOnly !== undefined && parent.rollbackOnly === undefined) {
    parent.rollbackOnly = child.rollbackOnly;
  }
}

/** A failed savepoint cleanup poisons the whole physical transaction. */
export function markTransactionRollbackOnly(
  scope: TransactionCallbackScope,
  error: unknown,
): void {
  let current: TransactionCallbackScope | undefined = scope;
  while (current !== undefined) {
    current.rollbackOnly ??= error;
    current = current.parent;
  }
}

export function assertTransactionCanCommit(scope: TransactionCallbackScope): void {
  if (scope.rollbackOnly !== undefined) {
    throw scope.rollbackOnly;
  }
}
