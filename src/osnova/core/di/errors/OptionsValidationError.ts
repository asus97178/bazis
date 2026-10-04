import { DiError } from "./DiError";

export class OptionsValidationError extends DiError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Options validation failed:\n${issues.join("\n")}`);
  }
}
