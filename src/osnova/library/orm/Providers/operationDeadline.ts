import { OrmTransactionScopeError } from "../errors";

export function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result <= 0 || result > 2_147_483_647) throw new TypeError(`${name} must be an integer between 1 and 2147483647.`);
  return result;
}

/** One deadline; disposing removes both the timer and the caller's listener. */
export class OperationDeadline {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.controller.abort(new OrmTransactionScopeError("ORM operation was aborted."));

  constructor(timeoutMs: number, private readonly parent?: AbortSignal) {
    if (parent !== undefined && !(parent instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
    this.timer = setTimeout(() => this.controller.abort(new OrmTransactionScopeError("ORM operation deadline exceeded.")), timeoutMs);
    if (parent?.aborted) this.onAbort();
    else parent?.addEventListener("abort", this.onAbort, { once: true });
  }

  wait<T>(work: PromiseLike<T>): Promise<T> { return awaitWithSignal(work, this.signal); }

  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onAbort);
  }
}

/** The caller owns termination of work; racing alone never proves cleanup. */
export function awaitWithSignal<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(work);
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
