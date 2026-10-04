import { ShutdownTimeoutError } from "../errors";

/** A deadline ends observation; the owner must retain the actual cleanup work. */
export async function awaitShutdown(work: Promise<void>, timeoutMs: number, elapsedMs = 0): Promise<void> {
  if (timeoutMs === 0) return work;
  if (elapsedMs >= timeoutMs) {
    void work.catch(() => undefined);
    throw new ShutdownTimeoutError(timeoutMs);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ShutdownTimeoutError(timeoutMs)), Math.max(0, timeoutMs - elapsedMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
