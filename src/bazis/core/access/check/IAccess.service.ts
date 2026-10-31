import type { ServiceResolver } from "../../di";
import type { AuthorizeContext } from "../../http";
import type { AccessPolicy } from "../contracts/AccessPolicy";
import type { AccessSubject } from "../contracts/types";
import type { SubjectAccess } from "./Access";

/**
 * Checks of access (ACCESS-001 §5): `for(ctx)` — the subject of a request,
 * `as(subject, scope)` — without HTTP (services, agents, background work).
 */
export abstract class IAccess {
  /** The application's rights system in this scope. */
  abstract policy(scope: ServiceResolver): AccessPolicy;
  /** Who makes the request, or `undefined`. */
  abstract subject(ctx: AuthorizeContext): Promise<AccessSubject | undefined>;
  /** Access of the request's subject; without one — 401. */
  abstract for(ctx: AuthorizeContext): Promise<SubjectAccess>;
  /** Access of a known subject; `scope` — where to resolve the policy and the lookups. */
  abstract as(subject: AccessSubject, scope: ServiceResolver): SubjectAccess;
}
