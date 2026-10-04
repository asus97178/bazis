/**
 * Typed event identity (compile-safe analog of Spring ApplicationEvents).
 * The payload type lives only in the type system; the symbol id is used as a
 * service key for handler registrations — no reflection involved.
 */
export interface EventToken<T> {
  readonly id: symbol;
  readonly name: string;
  /** Phantom field carrying the payload type; never set at runtime. */
  readonly _payload?: T;
}

export function createEventToken<T>(name: string): EventToken<T> {
  return { id: Symbol(name), name };
}

export type EventHandler<T> = (payload: T) => void | Promise<void>;
