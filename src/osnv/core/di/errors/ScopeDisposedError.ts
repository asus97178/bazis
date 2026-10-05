import { DiError } from "./DiError";

export class ScopeDisposedError extends DiError {
  public constructor() {
    super("Cannot use a disposed scope or container.");
  }
}
