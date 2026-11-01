import type { ConfigView } from "../../kernel";
import { PRINCIPAL_STATE_KEY, type AuthorizeContext, type RequestPrincipal } from "../../http";
import type { IAccessCatalog } from "../catalog/IAccessCatalog.service";
import type { AccessConfig } from "../check/accessConfig";
import { AccessPolicy, type ScopePrincipals } from "../contracts/AccessPolicy";
import type { AccessSubject, Grant, Grants, Scope } from "../contracts/types";

/** The subject of the default rights system: the account id and its roles from the token. */
export interface RoleSubject extends AccessSubject {
  readonly id: string;
  readonly roles: readonly string[];
}

/**
 * The default `AccessPolicy` (ACCESS-001 §8); an application replaces it by
 * registering its own: `singleton(AccessPolicy, AppAccessPolicy)`. The principal of the route check is the subject, its roles come from the
 * `access.roleClaim` claim, their permissions from `@Module({ roles })`. A role
 * nobody declared gives nothing; without roles everything is denied. A step
 * until `bazis/identity`.
 */
export class RolesAccessPolicy extends AccessPolicy {
  constructor(private readonly catalog: IAccessCatalog, private readonly config: ConfigView<AccessConfig>) {
    super();
  }

  subject(ctx: AuthorizeContext): RoleSubject | undefined {
    const principal = ctx.state.get(PRINCIPAL_STATE_KEY) as RequestPrincipal | undefined;
    const id = principal?.subject;
    if (id === undefined || id === "") return undefined;
    const kindClaim = this.config.get("kindClaim");
    const kind = kindClaim === "" ? undefined : principal!.findFirst?.(kindClaim);
    const roles = (principal!.findFirst?.(this.config.get("roleClaim")) ?? "").split(/[\s,]+/).filter((role) => role !== "");
    return { sub: kind === undefined || kind === "" ? id : `${kind}:${id}`, id, roles };
  }

  grants(subject: AccessSubject, permission: string): Grants {
    const grants: Grant[] = [];
    for (const name of rolesOf(subject)) {
      const role = this.catalog.role(name);
      if (role === undefined) continue;
      if (role.permissions === "all") return "all";
      for (const item of role.permissions) if (item.permission === permission) grants.push(item.grant);
    }
    return grants;
  }

  ownerIds(subject: AccessSubject): readonly string[] {
    return [idOf(subject)];
  }

  async principals(subject: AccessSubject, scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    const principals = [`user:${idOf(subject)}`, ...rolesOf(subject).map((role) => `role:${role}`)];
    return scopes.map((scope) => ({ scope, principals }));
  }
}

function rolesOf(subject: AccessSubject): readonly string[] {
  const roles = (subject as Partial<RoleSubject>).roles;
  return Array.isArray(roles) ? roles : [];
}

function idOf(subject: AccessSubject): string {
  return (subject as Partial<RoleSubject>).id ?? subject.sub;
}
