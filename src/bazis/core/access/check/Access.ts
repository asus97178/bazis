import type { Class, ServiceResolver } from "../../di";
import { UnauthorizedError, type AuthorizeContext } from "../../http";
import { LOGGER, type ConfigView } from "../../kernel";
import type { AccessCatalog } from "../catalog/AccessCatalog";
import type { PermissionSpec } from "../catalog/permissions";
import { AccessPolicy, type ScopePrincipals } from "../contracts/AccessPolicy";
import type { AttributeLookup } from "../contracts/AttributeLookup";
import type { AccessObject, AccessSubject, Condition, Grant, Grants, Scope } from "../contracts/types";
import { RolesAccessPolicy } from "../roles/RolesAccessPolicy";
import { evaluate, grantProblem } from "./conditions";
import { buildFilter, type AccessFilter } from "./filter";

const SUBJECT_STATE = "access:subject";

type AccessSettings = ConfigView<{ kindClaim: string; roleClaim: string; maxInList: number }>;

/** The fields the subject may read and write on an object. */
export interface FieldAccess {
  readonly read: "all" | readonly string[];
  readonly write: "all" | readonly string[];
}

/**
 * Checks of access (ACCESS-001 §5), scoped: asks the application's
 * `AccessPolicy` (the roles of `@Module({ roles })` without one) for grants and
 * applies them itself. `for(ctx)` — the subject of a request, cached on it;
 * `as(subject)` — without HTTP: services, agents.
 */
export class Access {
  constructor(private readonly resolver: ServiceResolver, private readonly catalog: AccessCatalog, private readonly config: AccessSettings) {}

  /** The application's rights system. */
  policy(): AccessPolicy {
    return this.resolver.tryResolve(AccessPolicy) ?? this.resolver.resolve(RolesAccessPolicy);
  }

  /** Who makes the request, or `undefined`. */
  async subject(ctx: AuthorizeContext): Promise<AccessSubject | undefined> {
    return (await this.cached(ctx))?.subject;
  }

  /** Access of the request's subject; without one — 401. */
  async for(ctx: AuthorizeContext): Promise<SubjectAccess> {
    const access = await this.cached(ctx);
    if (access === undefined) throw new UnauthorizedError();
    return access;
  }

  /** Access of a known subject, without a request. */
  as(subject: AccessSubject): SubjectAccess {
    return new SubjectAccess(subject, this.policy(), this.catalog, this.config.get("maxInList"), (type) => this.resolver.resolve(type), this.resolver);
  }

  private async cached(ctx: AuthorizeContext): Promise<SubjectAccess | undefined> {
    if (ctx.state.has(SUBJECT_STATE)) return ctx.state.get(SUBJECT_STATE) as SubjectAccess | undefined;
    const subject = await this.policy().subject(ctx);
    const access = subject === undefined ? undefined : this.as(subject);
    ctx.state.set(SUBJECT_STATE, access);
    return access;
  }
}

/** What one subject may do; grants are asked once per permission. */
export class SubjectAccess {
  private readonly grantCache = new Map<string, Promise<Grants>>();
  private owners: Promise<readonly string[]> | undefined;

  constructor(
    readonly subject: AccessSubject,
    private readonly policy: AccessPolicy,
    private readonly catalog: AccessCatalog,
    private readonly maxInList: number,
    private readonly lookup: (type: Class<AttributeLookup>) => AttributeLookup,
    private readonly resolver: ServiceResolver,
  ) {}

  /** The grants of the permission; a grant the permission cannot use is dropped with a warning. */
  grants(permission: string): Promise<Grants> {
    let grants = this.grantCache.get(permission);
    if (grants === undefined) {
      grants = this.load(permission);
      this.grantCache.set(permission, grants);
    }
    return grants;
  }

  /**
   * Whether the subject may do `permission` on `object`. Without an object —
   * whether it has the permission anywhere (a route before the object is known).
   */
  async can(permission: string, object?: AccessObject): Promise<boolean> {
    const spec = this.catalog.require(permission).spec;
    const grants = await this.grants(permission);
    if (grants === "all") return true;
    if (object === undefined) return grants.length > 0;
    return (await this.matching(permission, spec, grants, object)).length > 0;
  }

  /** Which rows of a list the subject may see; `scope` — the partition of the request for `scope: "request"`. */
  async filter(permission: string, options: { readonly scope?: Scope } = {}): Promise<AccessFilter> {
    const spec = this.catalog.require(permission).spec;
    const grants = await this.grants(permission);
    return await buildFilter({
      permission,
      spec,
      grants,
      ownerIds: grants === "all" || !usesOwn(grants) ? [] : await this.ownerIds(),
      requestScope: options.scope,
      maxInList: this.maxInList,
      lookup: this.lookup,
    });
  }

  /** The fields of `object` the subject may read and write (ACCESS-001 §4.4). */
  async fields(permission: string, object: AccessObject): Promise<FieldAccess> {
    const spec = this.catalog.require(permission).spec;
    const grants = await this.grants(permission);
    if (grants === "all") return { read: "all", write: "all" };
    const matching = await this.matching(permission, spec, grants, object);
    return { read: union(matching, "read"), write: union(matching, "write") };
  }

  /** Whom the subject is in each partition, for tasks. */
  principals(scopes: readonly Scope[]): Promise<readonly ScopePrincipals[]> {
    return this.policy.principals(this.subject, scopes);
  }

  /** The owner column values that mean this subject. */
  ownerIds(): Promise<readonly string[]> {
    this.owners ??= Promise.resolve(this.policy.ownerIds(this.subject));
    return this.owners;
  }

  private async load(permission: string): Promise<Grants> {
    const spec = this.catalog.require(permission).spec;
    const grants = await this.policy.grants(this.subject, permission);
    if (grants === "all") return "all";
    if (!Array.isArray(grants)) {
      this.warn(permission, "the rights system must answer \"all\" or a list of grants");
      return [];
    }
    return grants.filter((grant) => {
      const problem = grantProblem(spec, grant, this.maxInList);
      if (problem !== undefined) this.warn(permission, problem);
      return problem === undefined;
    });
  }

  private async matching(permission: string, spec: PermissionSpec, grants: readonly Grant[], object: AccessObject): Promise<Grant[]> {
    const scopes = objectScopes(permission, spec, object);
    const owners = usesOwn(grants) ? await this.ownerIds() : [];
    return grants.filter((grant) => {
      if (grant.scopes !== "all" && !scopes.some((scope) => (grant.scopes as readonly Scope[]).includes(scope))) return false;
      return grant.where === undefined || evaluate(grant.where, object, spec, owners) === true;
    });
  }

  private warn(permission: string, problem: string): void {
    this.resolver.tryResolve(LOGGER)?.warn("access grant dropped", { permission, subject: this.subject.sub, problem });
  }
}

function objectScopes(permission: string, spec: PermissionSpec, object: AccessObject): readonly Scope[] {
  if ((spec.scope ?? "none") === "none") return [null];
  const scope = object.scope;
  if (scope === undefined) throw new TypeError(`can("${permission}") needs the object's partition: pass { scope }.`);
  return Array.isArray(scope) ? scope : [scope as Scope];
}

function usesOwn(grants: readonly Grant[]): boolean {
  return grants.some((grant) => grant.where !== undefined && hasOwn(grant.where));
}

function hasOwn(condition: Condition): boolean {
  if ("own" in condition) return condition.own === true;
  if ("not" in condition && typeof condition.not === "object" && condition.not !== null) return hasOwn(condition.not as Condition);
  const list = "all" in condition ? condition.all : "any" in condition ? condition.any : undefined;
  return Array.isArray(list) && (list as readonly Condition[]).some(hasOwn);
}

function union(grants: readonly Grant[], side: "read" | "write"): "all" | readonly string[] {
  const fields = new Set<string>();
  for (const grant of grants) {
    const list = grant.fields?.[side];
    if (list === undefined || list === "all") return "all";
    for (const field of list) fields.add(field);
  }
  return [...fields];
}

/** The record with only the fields of `read`. */
export function maskFields<T extends Record<string, unknown>>(record: T, read: "all" | readonly string[]): Partial<T> {
  if (read === "all") return record;
  const allowed = new Set(read);
  return Object.fromEntries(Object.entries(record).filter(([field]) => allowed.has(field))) as Partial<T>;
}
