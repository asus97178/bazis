import { DiError } from "./DiError";

/** A module-owned provider was also registered through another DI path. */
export class ModuleOwnedProviderConflictError extends DiError {
  public constructor(public readonly issues: readonly string[]) {
    super(`Module-owned provider registration conflict:\n${issues.join("\n")}`);
  }
}
