/** One hosted service that failed to start, by its diagnostic name. */
export interface StartupFailure {
  readonly name: string;
  readonly error: unknown;
}

/**
 * Several services that start together (connections of the infrastructure
 * manifest) failed. `failures` keeps every one with its name, so the startup
 * screen shows all of them at once.
 */
export class StartupFailuresError extends AggregateError {
  public constructor(public readonly failures: readonly StartupFailure[]) {
    super(failures.map((failure) => failure.error), `${failures.length} services failed to start: ${failures.map((failure) => failure.name).join(", ")}.`);
    this.name = "StartupFailuresError";
  }
}
