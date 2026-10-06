const REDACTED = "***";

/**
 * A secret value that never leaks through logs: toString/toJSON/inspect all
 * print "***". The raw value is available only via an explicit `reveal()`.
 */
export class Secret {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
  }

  public reveal(): string {
    return this.#value;
  }

  public toString(): string {
    return REDACTED;
  }

  public toJSON(): string {
    return REDACTED;
  }

  public [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${REDACTED})`;
  }
}
