import { DiError } from "./DiError";

export class AmbiguousNamedDependencyError extends DiError {
  public constructor(name: string) {
    super(
      `Multiple provider tokens share the debug name "${name}", named dependency resolution is ambiguous. ` +
        `Rename one of the tokens or declare deps explicitly.`,
    );
  }
}
