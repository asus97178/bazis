import { DiError } from "./DiError";

export class ModuleEncapsulationError extends DiError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Module encapsulation violated:\n${issues.join("\n")}`);
  }
}
