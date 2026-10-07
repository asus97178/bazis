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
      `Class provider "${tokenToDebugName(token)}" requires at least ${requiredConstructorParams} constructor deps, but only ${declaredDeps} declared. Constructor dependencies are wired by codegen: if the constructor was added or changed after the last run, run \`bazis codegen\` (bazis dev, bazis test and bazis build run it automatically); otherwise pass the deps explicitly.`,
    );
  }
}
