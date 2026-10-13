/**
 * The start ran out of time. Not a configuration error: something it waited
 * for did not answer, and `pending` names it when a hosted service was starting.
 */
export class StartupTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number, public readonly pending?: string) {
    super(`Application startup did not finish within ${timeoutMs}ms${pending === undefined ? "." : `; still starting: ${pending}.`}`);
    this.name = "StartupTimeoutError";
  }
}
