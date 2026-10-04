import { DiError } from "./DiError";

export class NamedDependencyNotFoundError extends DiError {
  public constructor(name: string) {
    super(`No provider token found for named dependency "${name}".`);
  }
}
