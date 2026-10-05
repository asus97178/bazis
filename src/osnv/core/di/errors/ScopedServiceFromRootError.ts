import { tokenToDebugName } from "../token";
import type { Token } from "../token";
import { DiError } from "./DiError";

export class ScopedServiceFromRootError extends DiError {
  public constructor(token: Token<unknown>) {
    super(`Cannot resolve scoped service "${tokenToDebugName(token)}" from root provider.`);
  }
}
