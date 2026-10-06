import { KernelError } from "./KernelError";

export class ConfigKeyMissingError extends KernelError {
  public constructor(public readonly key: string) {
    super(`Required configuration key "${key}" is missing.`);
  }
}
