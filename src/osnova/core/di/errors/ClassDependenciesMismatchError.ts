import { tokenToDebugName } from "../token";
import type { Token } from "../token";
import { DiError } from "./DiError";

export class ClassDependenciesMismatchError extends DiError {
  public constructor(
    token: Token<unknown>,
    requiredConstructorParams: number,
    declaredDeps: number,
  ) {
    super(
      `Class provider "${tokenToDebugName(token)}" requires at least ${requiredConstructorParams} constructor deps, but only ${declaredDeps} declared.`,
    );
  }
}
