import { KernelError } from "./KernelError";

export class ShutdownTimeoutError extends KernelError {
  public constructor(public readonly timeoutMs: number) {
    super(`Graceful shutdown did not finish within ${timeoutMs}ms.`);
  }
}
