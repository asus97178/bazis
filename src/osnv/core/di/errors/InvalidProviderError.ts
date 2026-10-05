import { DiError } from "./DiError";

export class InvalidProviderError extends DiError {
  public constructor(tokenName: string) {
    super(
      `Provider for "${tokenName}" has unknown shape: expected one of useClass/useFactory/useValue.`,
    );
  }
}
