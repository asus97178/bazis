import { DiError } from "./DiError";

export class InvalidProviderError extends DiError {
  /** `message` replaces the default text when the caller knows more (the module and position). */
  public constructor(tokenName: string, message?: string) {
    super(
      message ?? `Provider for "${tokenName}" has unknown shape: expected one of useClass/useFactory/useValue.`,
    );
  }
}
