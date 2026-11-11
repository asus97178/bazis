/**
 * Test helpers of access (ACCESS-001 §8): a rights system whose grants are set
 * right in the test.
 */
import { singletonValue, type ProviderDefinition } from "../../di";
import { PRINCIPAL_STATE_KEY, type AuthorizeContext, type RequestPrincipal } from "../../http";
import { AccessPolicy, type ScopePrincipals } from "../contracts/AccessPolicy";
import type { AccessSubject, Grants, Scope } from "../contracts/types";

export interface StaticAccessOptions {
  /** Subject → permission → grants; a permission not listed gives {@link otherwise}. */
  readonly grants?: Readonly<Record<string, Readonly<Record<string, Grants>>>>;
  /** What a permission not listed in `grants` gives: nothing by default, `"all"` to allow everything. */
  readonly otherwise?: Grants;
  /** Who a request without a signed-in principal is; by default nobody, and the request is refused. */
  readonly anonymous?: string;
  /** Subject → the owner ids meaning it; by default `sub` after the last `:`. */
  readonly owners?: Readonly<Record<string, readonly string[]>>;
  /** Subject → its addressees in every partition; by default `user:<owner id>`. */
  readonly principals?: Readonly<Record<string, readonly string[]>>;
}

/**
 * A rights system for tests: the subject is the principal's `subject` of the
 * route check, grants come from the table.
 *
 * ```ts
 * singletonValue(AccessPolicy, new StaticAccessPolicy({
 *   grants: { "user:1": { "orders.read": [{ scopes: "all", where: { own: true } }] } },
 * }))
 * ```
 */
export class StaticAccessPolicy extends AccessPolicy {
  constructor(private readonly options: StaticAccessOptions) {
    super();
  }

  subject(ctx: AuthorizeContext): AccessSubject | undefined {
    const sub = (ctx.state.get(PRINCIPAL_STATE_KEY) as RequestPrincipal | undefined)?.subject;
    if (sub !== undefined && sub !== "") return { sub };
    return this.options.anonymous === undefined ? undefined : { sub: this.options.anonymous };
  }

  grants(subject: AccessSubject, permission: string): Grants {
    return this.options.grants?.[subject.sub]?.[permission] ?? this.options.otherwise ?? [];
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return this.options.owners?.[subject.sub] ?? [ownerId(subject.sub)];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    const principals = this.options.principals?.[subject.sub] ?? [`user:${ownerId(subject.sub)}`];
    return scopes.map((scope) => ({ scope, principals }));
  }
}

/**
 * A rights system that allows everything, for a test that is not about rights:
 * every subject has every permission in every partition.
 *
 * ```ts
 * const app = await startTestApp(OrdersApp, { overrides: [allowAll()] });
 * ```
 *
 * Requests still need a signed-in principal; `allowAll({ anonymous: "test" })`
 * also lets in a request without one, as the subject `test`. `grants` narrows
 * single subjects: `allowAll({ grants: { "user:2": { "orders.delete": [] } } })`.
 */
export function allowAll(options: Omit<StaticAccessOptions, "otherwise"> = {}): ProviderDefinition {
  return singletonValue(AccessPolicy, new StaticAccessPolicy({ ...options, otherwise: "all" }));
}

function ownerId(sub: string): string {
  return sub.slice(sub.lastIndexOf(":") + 1);
}
