import { KernelError } from "./KernelError";

export class StartupTimeoutError extends KernelError {
  public constructor(public readonly timeoutMs: number) {
    super(`Application startup did not finish within ${timeoutMs}ms.`);
  }
}
