import { KernelError } from "../errors";

/** Native timers overflow beyond this bound; zero explicitly disables a limit. */
export function validateTimeout(name: string, timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new KernelError(`${name} must be an integer between 0 and 2147483647 milliseconds.`);
  }
}
