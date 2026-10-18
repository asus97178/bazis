import { DiError } from "./DiError";

/** Returns a hint for a named dependency nobody registers, or `undefined`. */
export type NamedDependencyHint = (name: string) => string | undefined;

const hints: NamedDependencyHint[] = [];

/** Infrastructure extensions (ORM repositories, …) explain their own named dependencies here. */
export function registerNamedDependencyHint(hint: NamedDependencyHint): void {
  hints.push(hint);
}

function hintFor(name: string): string {
  const hint = hints.map((item) => item(name)).find((text) => text !== undefined);
  return hint ? ` ${hint}` : "";
}

/** The graph-validation issue for a named dependency nobody registers, naming the service that needs it. */
export function missingNamedDependencyIssue(name: string, requester: string): string {
  return `Missing dependency "${name}" for "${requester}".${hintFor(name)}`;
}

export class NamedDependencyNotFoundError extends DiError {
  public constructor(name: string) {
    super(`No provider token found for named dependency "${name}".${hintFor(name)}`);
  }
}
