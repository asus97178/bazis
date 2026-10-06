import { DbUpdateError } from "../errors";
import type { TransactionCallback } from "./types";

/** The server's final outcome could not be confirmed after (auto)commit or cancellation. */
export class TransactionOutcomeUnknownError extends DbUpdateError {
  readonly code = "ORM_TRANSACTION_OUTCOME_UNKNOWN";
  readonly outcome = "unknown";
  constructor(override readonly cause?: unknown, readonly phase: "commit" | "cancellation" = "commit") {
    super(phase === "commit"
      ? "Transaction outcome is unknown. Reconcile database state and use a new DbContext before saving again."
      : "Transaction cancellation is unconfirmed. Reconcile database state and use a new DbContext before saving again.");
  }
}

export function isUnknownTransactionOutcome(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (current === null || (typeof current !== "object" && typeof current !== "function") || seen.has(current)) continue;
    // Excessively wrapped failures are not safe candidates for automatic replay.
    if (seen.size >= 256) return true;
    seen.add(current);
    try {
      const code = Object.getOwnPropertyDescriptor(current, "code");
      if (code && "value" in code && code.value === "ORM_TRANSACTION_OUTCOME_UNKNOWN") return true;
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if (cause && "value" in cause) pending.push(cause.value);
      if (current instanceof AggregateError) {
        const errors = Object.getOwnPropertyDescriptor(current, "errors");
        if (errors && "value" in errors && Array.isArray(errors.value)) {
          if (errors.value.length > 256) return true;
          for (let index = 0; index < errors.value.length; index++) {
            const child = Object.getOwnPropertyDescriptor(errors.value, String(index));
            if (child && "value" in child) pending.push(child.value);
          }
        }
      }
    } catch { /* Never replace the original failure while classifying it. */ }
  }
  return false;
}

/** Only an explicit server rollback/constraint rejection proves COMMIT failed.
 * Connection errors (including SQLSTATE 08xxx) never establish that fact. */
export function isConfirmedCommitRejection(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    for (const name of ["errno", "code"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, name);
      const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof code === "string" && /^(?:40[0-9A-Z]{3}|23[0-9A-Z]{3})$/.test(code) && code !== "40003") return true;
    }
  } catch { return false; }
  return false;
}

/** An explicit statement ErrorResponse proves PostgreSQL rejected this command.
 * Transport loss, shutdown and statement_completion_unknown cannot prove that
 * an autocommit command did not commit before its response was lost. */
export function isConfirmedStatementRejection(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  try {
    for (const name of ["errno", "code"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, name);
      const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
        && !/^(?:00|01|02|08)/.test(code) && code !== "40003" && !/^57P0[123]$/.test(code)) return true;
    }
  } catch { return false; }
  return false;
}

// ORM rollback hooks also own provisional tracker state. On an unknown
// outcome notify only those internal hooks, never user afterRollback callbacks.
const uncertaintyHooks = new WeakMap<TransactionCallback, () => void>();
export function registerTransactionUncertainty(callback: TransactionCallback, uncertain: () => void): void {
  uncertaintyHooks.set(callback, uncertain);
}
export function notifyTransactionUncertainty(callbacks: readonly TransactionCallback[]): void {
  for (const callback of callbacks) uncertaintyHooks.get(callback)?.();
}
