import { tokenToDebugName } from "../token";
import type { Token } from "../token";
import { DiError } from "./DiError";

export class ScopedServiceFromRootError extends DiError {
  public constructor(token: Token<unknown>) {
    const name = tokenToDebugName(token);
    super(`Cannot resolve scoped service "${name}" from root provider. A scoped service lives in a request or a scope: create one with provider.createScope(), resolve "${name}" from it and dispose the scope when done.`);
  }
}
