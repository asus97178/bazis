/** One list-request parsing problem (tied to a specific parameter). */
export interface ListQueryProblem {
  /** Query parameter name, for example `sort`, `filter[age]`, `page[size]`. */
  readonly parameter: string;
  /** Human-readable description of the problem. */
  readonly message: string;
}

/**
 * List-request parsing/validation error. Collects all problems at once so the
 * client sees the full list, not just the first one.
 *
 * The library deliberately knows nothing about HTTP: the integration layer maps
 * it to 400 (see the `ListRequest` binding in `@/core/http`).
 */
export class ListQueryError extends Error {
  constructor(readonly problems: readonly ListQueryProblem[]) {
    super(
      problems.length > 0
        ? problems.map((problem) => `${problem.parameter}: ${problem.message}`).join("; ")
        : "Invalid list query",
    );
    this.name = "ListQueryError";
  }
}
