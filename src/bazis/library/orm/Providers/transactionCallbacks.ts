import { PostCommitError } from "../errors";
import type { TransactionCallback } from "./types";

const commitFinalizers = new WeakSet<TransactionCallback>();

/** Non-barrel tracker cleanup. A confirmed commit releases provisional
 * identities before user callbacks, regardless of registration order. */
export function registerPostCommitFinalizer(callback: TransactionCallback): void {
  commitFinalizers.add(callback);
}

export async function runPostCommitCallbacks(callbacks: readonly TransactionCallback[]): Promise<void> {
  const errors = await collectCallbackErrors(callbacks, true);
  errors.push(...await collectCallbackErrors(callbacks, false));
  if (errors.length > 0) {
    throw new PostCommitError(errors);
  }
}

export async function runRollbackCallbacks(
  callbacks: readonly TransactionCallback[],
  transactionError: unknown,
): Promise<never> {
  const callbackErrors = await collectCallbackErrors(callbacks);
  if (callbackErrors.length === 0) {
    throw transactionError;
  }
  throw new AggregateError(
    [transactionError, ...callbackErrors],
    "Transaction rolled back, but one or more rollback callbacks also failed.",
  );
}

async function collectCallbackErrors(callbacks: readonly TransactionCallback[], finalizers?: boolean): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    if (finalizers !== undefined && commitFinalizers.has(callback) !== finalizers) continue;
    try {
      await callback();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
