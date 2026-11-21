import type { Class, ServiceResolver } from "../../di";
import { UnauthorizedError, type AuthorizeContext } from "../../http";
import { LOGGER, type ConfigView } from "../../kernel";
import type { AccessConfig } from "./accessConfig";
import type { IAccessCatalog } from "../catalog/IAccessCatalog.service";
import type { OwnedPermission } from "../catalog/AccessCatalog";
import type { AnyPermissionKey, PermissionSpec } from "../catalog/permissions";
import { AccessPolicy, type ScopePrincipals } from "../contracts/AccessPolicy";
import type { AttributeLookup } from "../contracts/AttributeLookup";
import type { AccessObject, AccessSubject, Condition, Grant, Grants, Scope } from "../contracts/types";
import { evaluate, grantProblem } from "./conditions";
import { buildFilter, type AccessFilter } from "./filter";
import { IAccess } from "./IAccess.service";

const SUBJECT_STATE = "access:subject";

/** The fields the subject may read and write on an object. */
export interface FieldAccess {
  readonly read: "all" | readonly string[];
  readonly write: "all" | readonly string[];
}

/**
 * Asks the application's `AccessPolicy` for grants and applies them itself.
 * The subject of a request is cached on it. The policy and the lookups are
 * resolved in the given scope: an application may register them scoped.
 */
export class Access extends IAccess {
  constructor(private readonly catalog: IAccessCatalog, private readonly config: ConfigView<AccessConfig>) {
    super();
  }

  policy(scope: ServiceResolver): AccessPolicy {
    return scope.resolve(AccessPolicy);
  }

  async subject(ctx: AuthorizeContext): Promise<AccessSubject | undefined> {
    return (await this.cached(ctx))?.subject;
  }

  async for(ctx: AuthorizeContext): Promise<SubjectAccess> {
    const access = await this.cached(ctx);
    if (access === undefined) throw new UnauthorizedError();
    return access;
  }

  as(subject: AccessSubject, scope: ServiceResolver): SubjectAccess {
    return new SubjectAccess(subject, this.policy(scope), this.catalog, this.config.get("maxInList"), scope);
  }

  private async cached(ctx: AuthorizeContext): Promise<SubjectAccess | undefined> {
    if (ctx.state.has(SUBJECT_STATE)) return ctx.state.get(SUBJECT_STATE) as SubjectAccess | undefined;
    const subject = await this.policy(ctx.services).subject(ctx);
    const access = subject === undefined ? undefined : this.as(subject, ctx.services);
    ctx.state.set(SUBJECT_STATE, access);
    return access;
  }
}

/**
 * Why the subject may or may not do a permission on an object (ACCESS-001 §5.1):
 * `"all"` — the rights system answered `"all"` (a superuser), `"absent"` — a
 * permission of a source that does not exist now, `"grants"` — every grant the
 * rights system gave, in its order. `allowed` is the answer of `can`.
 */
export type AccessExplanation =
  | { readonly allowed: true; readonly kind: "all" }
  | { readonly allowed: false; readonly kind: "absent" }
  | { readonly allowed: boolean; readonly kind: "grants"; readonly grants: readonly GrantExplanation[] };

/** One grant in an explanation. */
export interface GrantExplanation {
  /** `Grant.id`. */
  readonly id?: string;
  /** The grant was dropped: why. `scope` and `where` are absent then. */
  readonly problem?: string;
  /** The partition of the object is among the grant's `scopes`. */
  readonly scope?: boolean;
  /** The result of the condition; `true` for a grant without `where`, `"unknown"` — an attribute has no value. */
  readonly where?: boolean | "unknown";
  /** The grant applies: the partition fits and the condition is true. */
  readonly applies: boolean;
  /** What this grant gives, for a grant that applies of a permission with `fields: true`. */
  readonly fields?: FieldAccess;
}

/** A grant as the rights system gave it, with the reason it cannot be used. */
interface Answered {
  readonly grant: Grant;
  readonly problem?: string;
}

/** The grants of a permission with the specification they were checked against. */
interface Given {
  readonly spec: PermissionSpec;
  /** The grants that can be used. */
  readonly grants: Grants;
  /** Every grant of the answer, in its order, the dropped ones too. */
  readonly answered: readonly Answered[];
}

/**
 * What one subject may do; grants are asked once per permission. A permission
 * of a source that the source does not give now does not exist: nobody has it,
 * and the rights system is not asked (ACCESS-001 §3.1).
 */
export class SubjectAccess {
  private readonly grantCache = new Map<string, Promise<Given | undefined>>();
  private owners: Promise<readonly string[]> | undefined;

  constructor(
    readonly subject: AccessSubject,
    private readonly policy: AccessPolicy,
    private readonly catalog: IAccessCatalog,
    private readonly maxInList: number,
    private readonly scope: ServiceResolver,
  ) {}

  /** The grants of the permission; a grant the permission cannot use is dropped with a warning. */
  async grants(permission: AnyPermissionKey): Promise<Grants> {
    return (await this.given(permission))?.grants ?? [];
  }

  /**
   * Whether the subject may do `permission` on `object`. Without an object —
   * whether it has the permission anywhere (a route before the object is known).
   */
  async can(permission: AnyPermissionKey, object?: AccessObject): Promise<boolean> {
    const given = await this.given(permission);
    if (given === undefined) return false;
    const { spec, grants } = given;
    if (grants === "all") return true;
    if (object === undefined) return grants.length > 0;
    return (await this.matching(permission, spec, grants, object)).length > 0;
  }

  /**
   * Why `can(permission, object)` answers what it answers: every grant with its
   * partition and condition (ACCESS-001 §5.1). The same code and the same
   * grants of the request as `can`. The answer shows the rules of another
   * person: the caller decides who may see it.
   */
  async explain(permission: AnyPermissionKey, object: AccessObject): Promise<AccessExplanation> {
    const given = await this.given(permission);
    if (given === undefined) return { allowed: false, kind: "absent" };
    const { spec, grants, answered } = given;
    if (grants === "all") return { allowed: true, kind: "all" };
    const scopes = objectScopes(permission, spec, object);
    const owners = usesOwn(grants) ? await this.ownerIds() : [];
    const explained = answered.map(({ grant, problem }): GrantExplanation => {
      const id = grantId(grant);
      const label = id === undefined ? {} : { id };
      if (problem !== undefined) return { ...label, problem, applies: false };
      const { scope, where } = judge(grant, scopes, object, spec, owners);
      const applies = scope && where === true;
      return {
        ...label,
        scope,
        where: where ?? "unknown",
        applies,
        ...(applies && spec.fields === true ? { fields: { read: union([grant], "read"), write: union([grant], "write") } } : {}),
      };
    });
    return { allowed: explained.some((grant) => grant.applies), kind: "grants", grants: explained };
  }

  /** Which rows of a list the subject may see; `scope` — the partition of the request for `scope: "request"`. */
  async filter(permission: AnyPermissionKey, options: { readonly scope?: Scope } = {}): Promise<AccessFilter> {
    const given = await this.given(permission);
    if (given === undefined) return { kind: "none" };
    const { spec, grants } = given;
    return await buildFilter({
      permission,
      spec,
      grants,
      ownerIds: grants === "all" || !usesOwn(grants) ? [] : await this.ownerIds(),
      requestScope: options.scope,
      maxInList: this.maxInList,
      lookup: (type: Class<AttributeLookup>) => this.scope.resolve(type),
    });
  }

  /** The fields of `object` the subject may read and write (ACCESS-001 §4.4). */
  async fields(permission: AnyPermissionKey, object: AccessObject): Promise<FieldAccess> {
    const given = await this.given(permission);
    if (given === undefined) return { read: [], write: [] };
    const { spec, grants } = given;
    if (grants === "all") return { read: "all", write: "all" };
    const matching = await this.matching(permission, spec, grants, object);
    return { read: union(matching, "read"), write: union(matching, "write") };
  }

  /**
   * The fields a list may be filtered and sorted by: those the subject reads by
   * every grant (ACCESS-001 §4.4). Rows of one list have different field lists,
   * and a filter by a closed field tells its values. `scope` — the partition of
   * the request for `scope: "request"`: only its grants count.
   */
  async filterableFields(permission: AnyPermissionKey, options: { readonly scope?: Scope } = {}): Promise<"all" | readonly string[]> {
    const given = await this.given(permission);
    if (given === undefined) return [];
    const { spec, grants } = given;
    if (grants === "all" || spec.fields !== true) return "all";
    if (spec.scope === "request" && options.scope === undefined) {
      throw new TypeError(`The fields of the list of "${permission}" need the partition of the request: filterableFields(permission, { scope }).`);
    }
    const used = spec.scope === "request" ? grants.filter((grant) => grant.scopes === "all" || grant.scopes.includes(options.scope!)) : grants;
    if (used.length === 0) return [];
    let common: readonly string[] | undefined;
    for (const grant of used) {
      const read = grant.fields?.read;
      if (read === undefined || read === "all") continue;
      common = common === undefined ? [...new Set(read)] : common.filter((field) => read.includes(field));
    }
    return common ?? "all";
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

  private given(permission: string): Promise<Given | undefined> {
    let given = this.grantCache.get(permission);
    if (given === undefined) {
      given = this.load(permission);
      this.grantCache.set(permission, given);
    }
    return given;
  }

  /** `undefined` — a permission of a source that does not exist now. */
  private async load(permission: string): Promise<Given | undefined> {
    let owned: OwnedPermission | undefined = await this.catalog.find(permission);
    if (owned === undefined) return undefined;
    const grants = await this.policy.grants(this.subject, permission);
    if (grants === "all") return { spec: owned.spec, grants: "all", answered: [] };
    if (!Array.isArray(grants)) {
      this.warn(permission, "the rights system must answer \"all\" or a list of grants");
      return { spec: owned.spec, grants: [], answered: [] };
    }
    let problems = grants.map((grant) => grantProblem(owned!.spec, grant, this.maxInList));
    if (owned.source !== undefined && problems.some((problem) => problem !== undefined)) {
      // The rule may name a field another instance has just added: compare the source's version before dropping it.
      const fresh = await this.catalog.find(permission, { verify: true });
      if (fresh === undefined) return undefined;
      if (fresh !== owned) {
        owned = fresh;
        problems = grants.map((grant) => grantProblem(fresh.spec, grant, this.maxInList));
      }
    }
    problems.forEach((problem, index) => { if (problem !== undefined) this.warn(permission, problem, grantId(grants[index])); });
    const answered = grants.map((grant, index): Answered => (problems[index] === undefined ? { grant } : { grant, problem: problems[index] }));
    return { spec: owned.spec, grants: grants.filter((_, index) => problems[index] === undefined), answered };
  }

  private async matching(permission: string, spec: PermissionSpec, grants: readonly Grant[], object: AccessObject): Promise<Grant[]> {
    const scopes = objectScopes(permission, spec, object);
    const owners = usesOwn(grants) ? await this.ownerIds() : [];
    return grants.filter((grant) => {
      const { scope, where } = judge(grant, scopes, object, spec, owners);
      return scope && where === true;
    });
  }

  private warn(permission: string, problem: string, grant?: string): void {
    this.scope.tryResolve(LOGGER)?.warn("access grant dropped", { permission, subject: this.subject.sub, problem, ...(grant === undefined ? {} : { grant }) });
  }
}

/** Whether the grant fits the object: its partition and its condition (`undefined` — unknown). `can` and `explain` share it. */
function judge(grant: Grant, scopes: readonly Scope[], object: AccessObject, spec: PermissionSpec, owners: readonly string[]): { readonly scope: boolean; readonly where: boolean | undefined } {
  return {
    scope: grant.scopes === "all" || scopes.some((scope) => (grant.scopes as readonly Scope[]).includes(scope)),
    where: grant.where === undefined ? true : evaluate(grant.where, object, spec, owners),
  };
}

/** `Grant.id` if the rights system gave one. */
function grantId(grant: unknown): string | undefined {
  const id = typeof grant === "object" && grant !== null ? (grant as { readonly id?: unknown }).id : undefined;
  return typeof id === "string" ? id : undefined;
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
