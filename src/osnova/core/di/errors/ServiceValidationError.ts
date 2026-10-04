import { DiError } from "./DiError";

export class ServiceValidationError extends DiError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Service graph validation failed:\n${issues.join("\n")}`);
  }
}
