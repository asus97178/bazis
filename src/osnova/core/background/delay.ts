/**
 * Cancellable pause. Resolves after `ms` **or** as soon as `signal` aborts —
 * it never rejects, so loops just re-check `signal.aborted` after awaiting:
 *
 * ```ts
 * while (!signal.aborted) {
 *   await work();
 *   await delay(1000, signal);
 * }
 * ```
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
