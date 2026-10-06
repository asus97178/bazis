/**
 * AST of WHERE conditions and a Proxy DSL to build it.
 *
 * Instead of parsing JS lambdas (unsafe and slow), the predicate is built
 * through a Proxy: `x => x.age.gt(18).and(x.name.startsWith("A"))`. `x.age`
 * returns a column operand, comparison methods produce AST nodes, and
 * `.and()/.or()/.not()` combine them. No user strings in the SQL, only parameters.
 *
 * Note: `&&`/`||` are not intercepted; use `.and()/.or()`.
 */

export type CompareOp = "=" | "<>" | ">" | ">=" | "<" | "<=" | "LIKE";

export type Condition =
  | {
      readonly kind: "compare";
      readonly property: string;
      readonly op: CompareOp;
      readonly value: unknown;
      /** For LIKE from startsWith/endsWith/contains: add `ESCAPE '\'`. */
      readonly escaped?: boolean;
    }
  | { readonly kind: "in"; readonly property: string; readonly values: readonly unknown[] }
  | { readonly kind: "tuples"; readonly properties: readonly string[]; readonly values: readonly (readonly unknown[])[] }
  | { readonly kind: "null"; readonly property: string; readonly negated: boolean }
  | { readonly kind: "and" | "or"; readonly left: Condition; readonly right: Condition }
  | { readonly kind: "not"; readonly inner: Condition };

/** Predicate result: a wrapper over an AST node with logical combinators. */
export class Predicate {
  constructor(readonly node: Condition) {}

  and(other: Predicate): Predicate {
    return new Predicate({ kind: "and", left: this.node, right: other.node });
  }
  or(other: Predicate): Predicate {
    return new Predicate({ kind: "or", left: this.node, right: other.node });
  }
  not(): Predicate {
    return new Predicate({ kind: "not", inner: this.node });
  }
}

/** Column operand: the entry point for building conditions on a property. */
export class Operand<T = unknown> {
  constructor(readonly property: string) {}

  private compare(op: CompareOp, value: unknown): Predicate {
    return new Predicate({ kind: "compare", property: this.property, op, value });
  }

  /** LIKE with escaped wildcards (needs `ESCAPE '\'` in SQL). */
  private likeEscaped(pattern: string): Predicate {
    return new Predicate({ kind: "compare", property: this.property, op: "LIKE", value: pattern, escaped: true });
  }

  eq(value: T): Predicate {
    return value === null ? this.isNull() : this.compare("=", value);
  }
  ne(value: T): Predicate {
    return value === null ? this.isNotNull() : this.compare("<>", value);
  }
  gt(value: OrderedValue<T>): Predicate {
    return this.compare(">", value);
  }
  gte(value: OrderedValue<T>): Predicate {
    return this.compare(">=", value);
  }
  lt(value: OrderedValue<T>): Predicate {
    return this.compare("<", value);
  }
  lte(value: OrderedValue<T>): Predicate {
    return this.compare("<=", value);
  }
  like(pattern: TextValue<T>): Predicate {
    return this.compare("LIKE", pattern);
  }
  startsWith(value: TextValue<T>): Predicate {
    return this.likeEscaped(`${escapeLike(value)}%`);
  }
  endsWith(value: TextValue<T>): Predicate {
    return this.likeEscaped(`%${escapeLike(value)}`);
  }
  contains(value: TextValue<T>): Predicate {
    return this.likeEscaped(`%${escapeLike(value)}%`);
  }
  in(values: readonly T[]): Predicate {
    return new Predicate({ kind: "in", property: this.property, values: [...values] });
  }
  isNull(): Predicate {
    return new Predicate({ kind: "null", property: this.property, negated: false });
  }
  isNotNull(): Predicate {
    return new Predicate({ kind: "null", property: this.property, negated: true });
  }
}

/** `%` and `_` in startsWith/endsWith/contains must not act as wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

type OrderedValue<T> = unknown extends T ? unknown
  : NonNullable<T> extends string | number | bigint | Date ? NonNullable<T> : never;
type TextValue<T> = unknown extends T ? string : NonNullable<T> extends string ? string : never;

/** Field selector (for where/orderBy). Returns a typed property operand. */
export type FieldSelector<T> = {
  readonly [K in keyof T]-?: Operand<T[K]>;
};

/** Predicate function passed to where. */
export type PredicateFn<T> = (entity: FieldSelector<T>) => Predicate;

/** Sorting needs only the column name, whatever the type of its value. */
export type KeySelectorFn<T> = (entity: FieldSelector<T>) => Pick<Operand, "property">;

const FIELD_PROXY: ProxyHandler<object> = {
  get(_target, property): Operand {
    return new Operand(String(property));
  },
};

/** Creates a Proxy selector of the entity fields. */
export function fieldSelector<T>(): FieldSelector<T> {
  return new Proxy({}, FIELD_PROXY) as FieldSelector<T>;
}
