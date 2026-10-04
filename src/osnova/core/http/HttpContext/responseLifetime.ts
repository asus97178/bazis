import { finished } from "node:stream";

/**
 * Observe the original body without locking, reading, cloning or replacing it.
 * Bun can consequently retain its native file/range/sendfile handling.
 * The returned promise settles after request-scope cleanup, for host shutdown.
 */
export function holdResponseScope(
  response: Response,
  signal: AbortSignal,
  dispose: () => Promise<void>,
): Promise<void> {
  const body = response.body;
  if (!body) return Promise.resolve().then(dispose);
  if (response.bodyUsed || body.locked) throw new TypeError("Response body is already in use");

  let complete!: () => void;
  let reject!: (reason: unknown) => void;
  const completion = new Promise<void>((resolve, fail) => { complete = resolve; reject = fail; });
  let ended = false;
  let cleanup = (): void => {};
  let handoffCheck: ReturnType<typeof setImmediate> | undefined;

  const finish = (): void => {
    if (ended) return;
    ended = true;
    cleanup();
    if (handoffCheck !== undefined) clearImmediate(handoffCheck);
    // Before Bun takes ownership (including an already-aborted request), an
    // unlocked producer still needs cancellation. Once locked, Bun owns it.
    if (signal.aborted && !body.locked) void body.cancel(signal.reason).catch(() => undefined);
    void Promise.resolve().then(dispose).then(complete, reject);
  };
  cleanup = finished(body, { signal }, finish);

  // Qualified Bun 1.4 consumes native Blob/file bodies directly: bodyUsed is
  // true, but no JS reader is acquired and its stream never emits finished.
  // After the response handoff, release that scope as for a materialized
  // result. A live JS producer remains locked and is observed until finished.
  // This is a single handoff check, not a timer-based stream lifetime limit.
  handoffCheck = setImmediate(() => {
    if (response.bodyUsed && !body.locked) finish();
  });
  return completion;
}
