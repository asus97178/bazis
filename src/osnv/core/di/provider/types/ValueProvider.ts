import type { Token } from "../../token";

export interface ValueProvider<T> {
  readonly provide: Token<T>;
  readonly useValue: T;
}
