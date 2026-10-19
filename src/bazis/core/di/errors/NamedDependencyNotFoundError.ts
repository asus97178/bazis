import { DiError } from "./DiError";

/** Returns a hint for a dependency nobody registers (by its name), or `undefined`. */
export type NamedDependencyHint = (name: string) => string | undefined;

const hints: NamedDependencyHint[] = [];

/** Infrastructure extensions (ORM repositories, the cache, …) explain their own dependencies here. */
export function registerNamedDependencyHint(hint: NamedDependencyHint): void {
  hints.push(hint);
}

function hintFor(name: string): string {
  const hint = hints.map((item) => item(name)).find((text) => text !== undefined);
  return hint ? ` ${hint}` : "";
}

/** The graph-validation issue for a dependency nobody registers, naming the service that needs it and the fix when one is known. */
export function missingDependencyIssue(name: string, requester: string): string {
  const hint = hintFor(name);
  return hint === "" ? `Missing dependency "${name}" for "${requester}"` : `Missing dependency "${name}" for "${requester}".${hint}`;
}

export class NamedDependencyNotFoundError extends DiError {
  public constructor(name: string) {
    super(`No provider token found for named dependency "${name}".${hintFor(name)}`);
  }
}
