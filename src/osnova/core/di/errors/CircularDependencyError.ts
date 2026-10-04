import { tokenToDebugName } from "../token";
import type { Token } from "../token";
import { DiError } from "./DiError";

export class CircularDependencyError extends DiError {
  public constructor(path: readonly Token<unknown>[]) {
    const chain = path.map((token) => tokenToDebugName(token)).join(" -> ");
    super(`Circular dependency detected: ${chain}`);
  }
}
