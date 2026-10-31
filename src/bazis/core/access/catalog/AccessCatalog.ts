import type { Class, ServiceProvider } from "../../di";
import type { References } from "../contracts/References";
import type { RolePermission } from "../roles/roles";
import { IAccessCatalog } from "./IAccessCatalog.service";
import { declarationsOf } from "./moduleFields";
import type { PermissionSpec } from "./permissions";

/** A permission of `@Module({ permissions })` with the module that declares it. */
export interface OwnedPermission {
  readonly key: string;
  readonly spec: PermissionSpec;
  readonly module: string;
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

/** The catalog read from the container's module contributions. */
export class AccessCatalog extends IAccessCatalog {
  private readonly byKey: ReadonlyMap<string, OwnedPermission>;
  private readonly byKind: ReadonlyMap<string, OwnedReferenceKind>;
  private readonly byName: ReadonlyMap<string, DeclaredRole>;

  constructor(services: ServiceProvider) {
    super();
    const { permissions, kinds, roles } = declarationsOf(services);
    this.byKey = new Map([...permissions].sort((a, b) => a.key.localeCompare(b.key)).map((item) => [item.key, item]));
    this.byKind = new Map([...kinds].sort((a, b) => a.kind.localeCompare(b.kind)).map((item) => [item.kind, item]));
    this.byName = new Map(roles.map((item) => [item.name, item]));
  }

  permissions(): readonly OwnedPermission[] {
    return [...this.byKey.values()];
  }

  permission(key: string): OwnedPermission | undefined {
    return this.byKey.get(key);
  }

  require(key: string): OwnedPermission {
    const permission = this.byKey.get(key);
    if (permission === undefined) throw new TypeError(`Permission "${key}" is not declared: add it to definePermissions(...) of a module's permissions.`);
    return permission;
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
