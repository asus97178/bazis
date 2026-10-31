import {
  createModuleOwnedMetadataChannel,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  DiContainer,
  type BazisModuleMetadata,
  type Class,
  type ServiceProvider,
} from "../../di";
import { grantProblem } from "../check/conditions";
import { AccessSetupError } from "../contracts/errors";
import type { References } from "../contracts/References";
import { isDeclaredRoles, rolePermission, type RoleDeclarations, type RolePermission } from "../roles/roles";
import { AccessCatalog, type DeclaredRole, type OwnedPermission, type OwnedReferenceKind } from "./AccessCatalog";
import { isDeclaredPermissions, isReferenceKind, lookupsOf, permissionProblems, type PermissionDeclarations, type PermissionSpec } from "./permissions";

interface PermissionPayload { readonly key: string; readonly spec: PermissionSpec }
interface ReferencePayload { readonly kind: string; readonly type: Class<References> }
interface RolePayload { readonly name: string; readonly permissions: "all" | readonly RolePermission[] }

const PERMISSION_CHANNEL = createModuleOwnedMetadataChannel<PermissionPayload>("access.permission/v1");
const REFERENCE_CHANNEL = createModuleOwnedMetadataChannel<ReferencePayload>("access.reference/v1");
const ROLE_CHANNEL = createModuleOwnedMetadataChannel<RolePayload>("access.role/v1");

/** The values of `in`/`notIn` a role may list; the run-time limit is `access.maxInList`. */
const STARTUP_MAX_IN_LIST = 1000;
const ROLE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

// Internal imports must not depend on the public barrel having augmented DI's metadata interface.
interface AccessModuleFields {
  readonly permissions?: unknown;
  readonly references?: unknown;
  readonly roles?: unknown;
}

registerModuleOwnedProviderContributor((metadata: BazisModuleMetadata, context) => {
  const fields = metadata as BazisModuleMetadata & AccessModuleFields;
  if (fields.permissions === undefined && fields.references === undefined && fields.roles === undefined) return;
  const module = moduleName(metadata);
  if (fields.permissions !== undefined) {
    if (!isDeclaredPermissions(fields.permissions)) throw new AccessSetupError(`${module}: permissions must be a definePermissions(...) result.`);
    const problems = Object.entries(fields.permissions).flatMap(([key, spec]) => permissionProblems(key, spec));
    if (problems.length > 0) throw setupError(module, "permissions", problems);
    for (const [key, spec] of Object.entries(fields.permissions)) context.addMetadata(PERMISSION_CHANNEL, { key, spec });
  }
  if (fields.references !== undefined) {
    const references = fields.references;
    if (typeof references !== "object" || references === null || Array.isArray(references)) throw new AccessSetupError(`${module}: references must map a reference kind to a References class.`);
    const problems: string[] = [];
    for (const [kind, type] of Object.entries(references)) {
      if (!isReferenceKind(kind)) problems.push(`reference kind "${kind}" must look like "<module>.<kind>" in lower case`);
      if (typeof type !== "function") problems.push(`reference kind "${kind}" must name a References class`);
    }
    if (problems.length > 0) throw setupError(module, "references", problems);
    for (const [kind, type] of Object.entries(references)) context.addMetadata(REFERENCE_CHANNEL, { kind, type: type as Class<References> });
  }
  if (fields.roles !== undefined) {
    if (!isDeclaredRoles(fields.roles)) throw new AccessSetupError(`${module}: roles must be a defineRoles(...) result.`);
    const problems: string[] = [];
    for (const [name, permissions] of Object.entries(fields.roles as RoleDeclarations)) {
      if (!ROLE.test(name)) problems.push(`role "${name}" must be a name of letters, digits, _, . and -`);
      if (permissions !== "all" && !Array.isArray(permissions)) problems.push(`role "${name}" must be "all" or a list of permissions`);
    }
    if (problems.length > 0) throw setupError(module, "roles", problems);
    for (const [name, permissions] of Object.entries(fields.roles as RoleDeclarations)) {
      context.addMetadata(ROLE_CHANNEL, { name, permissions: permissions === "all" ? "all" : permissions.map(rolePermission) });
    }
  }
});

registerModuleOwnedContributionValidator((snapshot) => {
  const permissions = snapshot.getMetadataContributions(PERMISSION_CHANNEL);
  const references = snapshot.getMetadataContributions(REFERENCE_CHANNEL);
  const roles = snapshot.getMetadataContributions(ROLE_CHANNEL);
  const first = permissions[0] ?? references[0] ?? roles[0];
  if (first === undefined) return;
  if (snapshot.countProviders(AccessCatalog) === 0) {
    throw new AccessSetupError(`${first.ownerName} declares access (permissions, references or roles), but the application does not import AccessModule (bazis/core/access).`);
  }

  const owners = new Map<string, string>();
  const specs = new Map<string, PermissionSpec>();
  for (const { payload, ownerName } of permissions) {
    const other = owners.get(payload.key);
    if (other !== undefined) throw new AccessSetupError(`Permission "${payload.key}" is declared twice: in ${other} and in ${ownerName}.`);
    owners.set(payload.key, ownerName);
    specs.set(payload.key, payload.spec);
  }

  const kinds = new Map<string, string>();
  for (const { payload, ownerName } of references) {
    const other = kinds.get(payload.kind);
    if (other !== undefined) throw new AccessSetupError(`Reference kind "${payload.kind}" is declared twice: in ${other} and in ${ownerName}.`);
    kinds.set(payload.kind, ownerName);
    if (snapshot.countProviders(payload.type) === 0) throw new AccessSetupError(`${ownerName}: ${payload.type.name} of reference kind "${payload.kind}" is not registered: add it to the module's providers.`);
  }

  for (const { payload, ownerName } of permissions) {
    for (const [name, attribute] of Object.entries(payload.spec.on ?? {})) {
      if (attribute.ref !== undefined && !kinds.has(attribute.ref)) {
        throw new AccessSetupError(`${ownerName}: permission "${payload.key}", attribute "${name}" refers to kind "${attribute.ref}", which no module declares in references.`);
      }
    }
    for (const lookup of lookupsOf(payload.spec)) {
      if (snapshot.countProviders(lookup) === 0) throw new AccessSetupError(`${ownerName}: ${lookup.name} of permission "${payload.key}" is not registered: add it to the module's providers.`);
    }
  }

  const names = new Map<string, string>();
  for (const { payload, ownerName } of roles) {
    const other = names.get(payload.name);
    if (other !== undefined) throw new AccessSetupError(`Role "${payload.name}" is declared twice: in ${other} and in ${ownerName}.`);
    names.set(payload.name, ownerName);
    if (payload.permissions === "all") continue;
    for (const { permission, grant } of payload.permissions) {
      const spec = specs.get(permission);
      if (spec === undefined) throw new AccessSetupError(`${ownerName}: role "${payload.name}" names permission "${permission}", which no module declares.`);
      const problem = grantProblem(spec, grant, STARTUP_MAX_IN_LIST);
      if (problem !== undefined) throw new AccessSetupError(`${ownerName}: role "${payload.name}", permission "${permission}": ${problem}.`);
    }
  }
});

/** The access catalog of the application's container. */
export function accessCatalogOf(services: ServiceProvider): AccessCatalog {
  if (!(services instanceof DiContainer)) throw new AccessSetupError("Access declarations require the framework DiContainer.");
  const permissions: OwnedPermission[] = services.getModuleOwnedMetadataContributions(PERMISSION_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  const kinds: OwnedReferenceKind[] = services.getModuleOwnedMetadataContributions(REFERENCE_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  const roles: DeclaredRole[] = services.getModuleOwnedMetadataContributions(ROLE_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  return new AccessCatalog(permissions, kinds, roles);
}

function setupError(module: string, field: string, problems: readonly string[]): AccessSetupError {
  return new AccessSetupError(`${module}: ${field} ${problems.length === 1 ? "has an error" : "have errors"}:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
}

function moduleName(metadata: BazisModuleMetadata): string {
  return typeof metadata === "function" ? (metadata as { name: string }).name || "<anonymous module>" : "<module>";
}

// Augment the declaring file, not the "../../di" re-export: re-export targets
// depend on program file order and silently stop merging in some projects.
declare module "../../di/module/types/BazisModule" {
  interface BazisModuleMetadata {
    /** What the module lets the administrator allow, from `definePermissions` (ACCESS-001 §3). */
    readonly permissions?: PermissionDeclarations;
    /** Reference kinds the module owns: kind → its `References` class, registered in `providers` (ACCESS-001 §6). */
    readonly references?: Readonly<Record<string, Class<References>>>;
    /** Roles of the default rights system, from `defineRoles` (ACCESS-001 §8). */
    readonly roles?: RoleDeclarations;
  }
}
