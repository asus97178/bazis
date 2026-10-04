// `any[]` is intentional: it lets concrete classes act as their own tokens
// without TS rejecting constructors with typed parameters. Runtime shape of
// constructor deps is still validated by the container.
export type Class<T> = new (...args: any[]) => T;

export interface InjectionToken<T> {
  readonly id: symbol;
  readonly description: string;
  readonly genericFamilyId?: symbol;
  readonly genericArgId?: symbol;
  readonly genericArgToken?: Token<unknown>;
}

export function createToken<T>(description: string): InjectionToken<T> {
  return {
    id: Symbol(description),
    description,
  };
}

export type Token<T> = Class<T> | InjectionToken<T>;

export interface OpenGenericTokenFamily<TArg, TResult> {
  readonly id: symbol;
  readonly description: string;
  of(argument: Token<TArg>): InjectionToken<TResult>;
}

export function createOpenGenericTokenFamily<TArg, TResult>(description: string): OpenGenericTokenFamily<TArg, TResult> {
  const familyId = Symbol(description);
  // Canonical closed tokens per argument: `of(X)` must always return the same
  // token instance, otherwise singleton identity breaks (a fresh token would
  // materialize a fresh registration and a fresh instance on every call).
  const closedTokens = new Map<symbol, InjectionToken<TResult>>();
  return {
    id: familyId,
    description,
    of(argument: Token<TArg>): InjectionToken<TResult> {
      const argumentId = getTokenStableId(argument);
      const existing = closedTokens.get(argumentId);
      if (existing) {
        return existing;
      }

      const closedDescription = `${description}<${tokenToDebugName(argument)}>`;
      const token: InjectionToken<TResult> = {
        id: Symbol(closedDescription),
        description: closedDescription,
        genericFamilyId: familyId,
        genericArgId: argumentId,
        genericArgToken: argument,
      };
      closedTokens.set(argumentId, token);
      return token;
    },
  };
}

export function tokenToDebugName(token: Token<unknown>): string {
  if (typeof token === "function") {
    return token.name || "<anonymous class>";
  }

  return token.description;
}

// Stable identity for class tokens is kept off-object in a WeakMap so the
// container never mutates user classes (no enumerable `__osnovaTokenId` leaks
// into Object.keys / serialization). Garbage-collected with the class itself.
const classTokenIds = new WeakMap<Function, symbol>();

function getTokenStableId(token: Token<unknown>): symbol {
  if (typeof token === "function") {
    const existing = classTokenIds.get(token);
    if (existing) {
      return existing;
    }
    const id = Symbol(token.name || "class-token");
    classTokenIds.set(token, id);
    return id;
  }

  return token.id;
}
