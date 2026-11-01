import type { AuthorizeContext } from "../../http";
import type { AccessSubject, Grants, Scope } from "./types";

/**
 * The rights system of the application (ACCESS-001 §4.1): a CMS roles module,
 * `bazis/identity`, or the roles of `@Module({ roles })` by default
 * (`RolesAccessPolicy`). It answers with data — grants — and the framework
 * checks objects and filters lists by them itself. The application replaces
 * the default in its module: `singleton(AccessPolicy, AppAccessPolicy)` (or
 * `scoped`, when it needs a DbContext).
 */
export abstract class AccessPolicy {
  /** Who makes the request: usually reads the principal the application's route check put into `ctx.state`. */
  abstract subject(ctx: AuthorizeContext): AccessSubject | undefined | Promise<AccessSubject | undefined>;

  /** What the subject is given by the permission. */
  abstract grants(subject: AccessSubject, permission: string): Grants | Promise<Grants>;

  /** The owner column values that mean "me" for `{ own: true }`: usually the bare account id. */
  abstract ownerIds(subject: AccessSubject): readonly string[] | Promise<readonly string[]>;

  /** Whom the subject is in each partition, for tasks: `user:<id>`, `role:<code>`, kinds of the application. */
  abstract principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]>;
}

export interface ScopePrincipals {
  readonly scope: Scope;
  readonly principals: readonly string[];
}
