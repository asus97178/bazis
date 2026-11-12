import type { Class } from "../../di";
import type { ServiceProvider } from "../../di/ServiceProvider";
import type { ConfigView } from "../../kernel";
import type { AccessConfig } from "../check/accessConfig";
import { grantProblem } from "../check/conditions";
import type { References } from "../contracts/References";
import type { Grant } from "../contracts/types";
import type { RolePermission } from "../roles/roles";
import { IAccessCatalog } from "./IAccessCatalog.service";
import { declarationsOf } from "./moduleFields";
import type { PermissionSpec } from "./permissions";
import type { PermissionSources, PermissionSourceState } from "./PermissionSources";

/** A permission with the module that declares it: in `@Module({ permissions })` or through a source. */
export interface OwnedPermission {
  readonly key: string;
  readonly spec: PermissionSpec;
  readonly module: string;
  /** The prefix of the source that gave the permission (ACCESS-001 §3.1); a declared one has none. */
  readonly source?: string;
}

/** A reference kind of `@Module({ references })`. */
export interface OwnedReferenceKind {
  readonly kind: string;
  readonly type: Class<References>;
  readonly module: string;
}

/** A role of `@Module({ roles })`: `"all"` or its permissions as grants. */
export interface DeclaredRole {
  readonly name: string;
  readonly permissions: "all" | readonly RolePermission[];
  readonly module: string;
}

/** The catalog: the container's module contributions and the permissions of the sources. */
export class AccessCatalog extends IAccessCatalog {
  private readonly byKey: ReadonlyMap<string, OwnedPermission>;
  private readonly byKind: ReadonlyMap<string, OwnedReferenceKind>;
  private readonly byName: ReadonlyMap<string, DeclaredRole>;

  constructor(services: ServiceProvider, private readonly sourced: PermissionSources, private readonly config: ConfigView<AccessConfig>) {
    super();
    const { permissions, kinds, roles } = declarationsOf(services);
    this.byKey = new Map([...permissions].sort((a, b) => a.key.localeCompare(b.key)).map((item) => [item.key, item]));
    this.byKind = new Map([...kinds].sort((a, b) => a.kind.localeCompare(b.kind)).map((item) => [item.kind, item]));
    this.byName = new Map(roles.map((item) => [item.name, item]));
  }

  permissions(): readonly OwnedPermission[] {
    const sourced = this.sourced.permissions();
    return sourced.length === 0 ? [...this.byKey.values()] : [...this.byKey.values(), ...sourced].sort((a, b) => a.key.localeCompare(b.key));
  }

  permission(key: string): OwnedPermission | undefined {
    return this.byKey.get(key) ?? this.sourced.permission(key);
  }

  require(key: string): OwnedPermission {
    const permission = this.permission(key);
    if (permission === undefined) throw this.unknown(key);
    return permission;
  }

  async find(key: string, options: { readonly verify?: boolean } = {}): Promise<OwnedPermission | undefined> {
    const declared = this.byKey.get(key);
    if (declared !== undefined) return declared;
    if (this.sourced.prefixOf(key) === undefined) throw this.unknown(key);
    const permission = this.sourced.permission(key);
    if (permission !== undefined && options.verify !== true) return permission;
    // A table another instance has just created, or a field it has just added, must not wait for the poll.
    await this.sourced.verify(key);
    return this.sourced.permission(key);
  }

  async grantProblem(permission: string, grant: Grant): Promise<string | undefined> {
    const maxInList = this.config.get("maxInList");
    const declared = this.byKey.get(permission);
    if (declared !== undefined) return grantProblem(declared.spec, grant, maxInList);
    if (this.sourced.prefixOf(permission) === undefined) return `permission "${permission}" is not declared`;
    const problemNow = (): string | undefined => {
      const found = this.sourced.permission(permission);
      return found === undefined ? `permission "${permission}" does not exist` : grantProblem(found.spec, grant, maxInList);
    };
    await this.sourced.verify(permission);
    const problem = problemNow();
    // A rule is saved rarely, and a wrong refusal costs the administrator: ask the version once more, past the limit.
    return problem !== undefined && await this.sourced.verify(permission, true) ? problemNow() : problem;
  }

  async changed(prefix: string, keys?: readonly string[]): Promise<void> {
    await this.sourced.changed(prefix, keys);
  }

  sources(): readonly PermissionSourceState[] {
    return this.sourced.state();
  }

  private unknown(key: string): TypeError {
    const prefix = this.sourced.prefixOf(key);
    return new TypeError(prefix === undefined
      ? `Permission "${key}" is not declared: add it to definePermissions(...) of a module's permissions.`
      : `Permission "${key}" does not exist: the permission source "${prefix}" does not give it now.`);
  }

  referenceKinds(): readonly OwnedReferenceKind[] {
    return [...this.byKind.values()];
  }

  referenceKind(kind: string): OwnedReferenceKind | undefined {
    return this.byKind.get(kind);
  }

  roles(): readonly DeclaredRole[] {
    return [...this.byName.values()];
  }

  role(name: string): DeclaredRole | undefined {
    return this.byName.get(name);
  }
}
