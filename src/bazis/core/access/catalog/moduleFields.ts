import {
  createModuleOwnedMetadataChannel,
  createModuleOwnedProviderChannel,
  scoped,
  registerModuleOwnedContributionValidator,
  registerModuleOwnedProviderContributor,
  DiContainer,
  type BazisModuleMetadata,
  type Class,
  type ServiceProvider,
} from "../../di";
import { grantProblem } from "../check/conditions";
import { AccessSetupError } from "../contracts/errors";
import type { PermissionSource } from "../contracts/PermissionSource";
import type { References } from "../contracts/References";
import { isDeclaredRoles, rolePermission, type RoleDeclarations, type RolePermission } from "../roles/roles";
import { IAccess } from "../check/IAccess.service";
import type { DeclaredRole, OwnedPermission, OwnedReferenceKind } from "./AccessCatalog";
import { isDeclaredPermissions, isReferenceKind, isSourcePrefix, lookupsOf, permissionProblems, underPrefix, type PermissionDeclarations, type PermissionSpec } from "./permissions";
import type { OwnedPermissionSource } from "./PermissionSources.service";

interface PermissionPayload { readonly key: string; readonly spec: PermissionSpec }
interface ReferencePayload { readonly kind: string; readonly type: Class<References> }
interface RolePayload { readonly name: string; readonly permissions: "all" | readonly RolePermission[] }
interface SourcePayload { readonly prefix: string; readonly type: Class<PermissionSource> }

const PERMISSION_CHANNEL = createModuleOwnedMetadataChannel<PermissionPayload>("access.permission/v1");
const REFERENCE_CHANNEL = createModuleOwnedMetadataChannel<ReferencePayload>("access.reference/v1");
const ROLE_CHANNEL = createModuleOwnedMetadataChannel<RolePayload>("access.role/v1");
const SOURCE_CHANNEL = createModuleOwnedMetadataChannel<SourcePayload>("access.permission-source/v1");
/** The classes of `permissionSources`: the field registers them, like the classes of `references`. */
const SOURCE_CLASS_CHANNEL = createModuleOwnedProviderChannel<{ readonly prefix: string }, object>("access.permission-source-class/v1");
/** The classes of `references`: the field registers them, like `tools` and `controllers`. */
const REFERENCE_CLASS_CHANNEL = createModuleOwnedProviderChannel<{ readonly kind: string }, object>("access.reference-class/v1");
/** The `lookup` classes of `permissions`: the field registers them too. */
const LOOKUP_CLASS_CHANNEL = createModuleOwnedProviderChannel<{ readonly permission: string }, object>("access.lookup-class/v1");

/** The values of `in`/`notIn` a role may list; the run-time limit is `access.maxInList`. */
const STARTUP_MAX_IN_LIST = 1000;
const ROLE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

// Internal imports must not depend on the public barrel having augmented DI's metadata interface.
interface AccessModuleFields {
  readonly permissions?: unknown;
  readonly references?: unknown;
  readonly roles?: unknown;
  readonly permissionSources?: unknown;
}

registerModuleOwnedProviderContributor((metadata: BazisModuleMetadata, context) => {
  const fields = metadata as BazisModuleMetadata & AccessModuleFields;
  if (fields.permissions === undefined && fields.references === undefined && fields.roles === undefined && fields.permissionSources === undefined) return;
  const module = moduleName(metadata);
  if (fields.permissions !== undefined) {
    if (!isDeclaredPermissions(fields.permissions)) throw new AccessSetupError(`${module}: permissions must be a definePermissions(...) result.`);
    const problems = Object.entries(fields.permissions).flatMap(([key, spec]) => permissionProblems(key, spec));
    if (problems.length > 0) throw setupError(module, "permissions", problems);
    const lookups = new Set<unknown>();
    for (const [key, spec] of Object.entries(fields.permissions)) {
      context.addMetadata(PERMISSION_CHANNEL, { key, spec });
      for (const lookup of lookupsOf(spec)) {
        // A lookup another module owns and exports is taken from it.
        if (lookups.has(lookup) || importsExport(metadata, lookup)) continue;
        lookups.add(lookup);
        try {
          context.registerScoped(LOOKUP_CLASS_CHANNEL, scoped(lookup as Class<object>), { permission: key });
        } catch {
          // The module registered the class its own way: that registration stands.
        }
      }
    }
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
    const registered = new Set<unknown>();
    for (const [kind, type] of Object.entries(references)) {
      context.addMetadata(REFERENCE_CHANNEL, { kind, type: type as Class<References> });
      if (registered.has(type)) continue;
      registered.add(type);
      try {
        context.registerScoped(REFERENCE_CLASS_CHANNEL, scoped(type as Class<object>), { kind });
      } catch {
        // The module registered the class its own way (a singleton): that registration stands.
      }
    }
  }
  if (fields.permissionSources !== undefined) {
    const sources = fields.permissionSources;
    if (typeof sources !== "object" || sources === null || Array.isArray(sources)) throw new AccessSetupError(`${module}: permissionSources must map a key prefix to a PermissionSource class.`);
    const problems: string[] = [];
    for (const [prefix, type] of Object.entries(sources)) {
      if (!isSourcePrefix(prefix)) problems.push(`prefix "${prefix}" must be one or several key segments in lower case, like "data" or "dm.records"`);
      if (typeof type !== "function") problems.push(`prefix "${prefix}" must name a PermissionSource class`);
    }
    if (problems.length > 0) throw setupError(module, "permissionSources", problems);
    const registered = new Set<unknown>();
    for (const [prefix, type] of Object.entries(sources)) {
      context.addMetadata(SOURCE_CHANNEL, { prefix, type: type as Class<PermissionSource> });
      if (registered.has(type)) continue;
      registered.add(type);
      try {
        context.registerScoped(SOURCE_CLASS_CHANNEL, scoped(type as Class<object>), { prefix });
      } catch {
        // The module registered the class its own way: that registration stands.
      }
    }
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
  const sources = snapshot.getMetadataContributions(SOURCE_CHANNEL);
  const first = permissions[0] ?? references[0] ?? roles[0] ?? sources[0];
  if (first === undefined) return;
  if (snapshot.countProviders(IAccess) === 0) {
    throw new AccessSetupError(`${first.ownerName} declares access (permissions, references, roles or permission sources), but the application does not import AccessModule (bazis/core/access).`);
  }

  const owners = new Map<string, string>();
  const specs = new Map<string, PermissionSpec>();
  for (const { payload, ownerName } of permissions) {
    const other = owners.get(payload.key);
    if (other !== undefined) throw new AccessSetupError(`Permission "${payload.key}" is declared twice: in ${other} and in ${ownerName}.`);
    owners.set(payload.key, ownerName);
    specs.set(payload.key, payload.spec);
  }

  // A source owns every key under its prefix: no declared key and no other source may be there.
  const prefixes = new Map<string, string>();
  for (const { payload, ownerName } of sources) {
    for (const [other, otherOwner] of prefixes) {
      if (other === payload.prefix) throw new AccessSetupError(`Permission source prefix "${payload.prefix}" is declared twice: in ${otherOwner} and in ${ownerName}.`);
      if (underPrefix(other, payload.prefix) || underPrefix(payload.prefix, other)) {
        throw new AccessSetupError(`Permission source prefixes "${other}" (${otherOwner}) and "${payload.prefix}" (${ownerName}) overlap: one lies under the other.`);
      }
    }
    prefixes.set(payload.prefix, ownerName);
    if (snapshot.countProviders(payload.type) === 0) throw new AccessSetupError(`${ownerName}: ${payload.type.name} of permission source "${payload.prefix}" is not registered.`);
    for (const [key, keyOwner] of owners) {
      if (key === payload.prefix || underPrefix(key, payload.prefix)) {
        throw new AccessSetupError(`Permission "${key}" of ${keyOwner} lies under the prefix "${payload.prefix}" of a permission source of ${ownerName}: a source owns every key of its prefix.`);
      }
    }
  }

  const kinds = new Map<string, string>();
  for (const { payload, ownerName } of references) {
    const other = kinds.get(payload.kind);
    if (other !== undefined) throw new AccessSetupError(`Reference kind "${payload.kind}" is declared twice: in ${other} and in ${ownerName}.`);
    kinds.set(payload.kind, ownerName);
    if (snapshot.countProviders(payload.type) === 0) throw new AccessSetupError(`${ownerName}: ${payload.type.name} of reference kind "${payload.kind}" is not registered.`);
  }

  for (const { payload, ownerName } of permissions) {
    for (const [name, attribute] of Object.entries(payload.spec.on ?? {})) {
      if (attribute.ref !== undefined && !kinds.has(attribute.ref)) {
        throw new AccessSetupError(`${ownerName}: permission "${payload.key}", attribute "${name}" refers to kind "${attribute.ref}", which no module declares in references.`);
      }
    }
    for (const lookup of lookupsOf(payload.spec)) {
      if (snapshot.countProviders(lookup) === 0) throw new AccessSetupError(`${ownerName}: ${lookup.name} of permission "${payload.key}" is not registered.`);
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

/** Whether a module the given one imports exports this class. */
function importsExport(metadata: BazisModuleMetadata, type: unknown): boolean {
  return (metadata.imports ?? []).some((imported) => {
    const exported = (imported as { readonly exports?: unknown }).exports;
    return Array.isArray(exported) && exported.includes(type);
  });
}

/** What the modules of the application's container declared. */
export function declarationsOf(services: ServiceProvider): { permissions: OwnedPermission[]; kinds: OwnedReferenceKind[]; roles: DeclaredRole[]; sources: OwnedPermissionSource[] } {
  if (!(services instanceof DiContainer)) throw new AccessSetupError("Access declarations require the framework DiContainer.");
  const permissions: OwnedPermission[] = services.getModuleOwnedMetadataContributions(PERMISSION_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  const kinds: OwnedReferenceKind[] = services.getModuleOwnedMetadataContributions(REFERENCE_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  const roles: DeclaredRole[] = services.getModuleOwnedMetadataContributions(ROLE_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  const sources: OwnedPermissionSource[] = services.getModuleOwnedMetadataContributions(SOURCE_CHANNEL).map(({ payload, ownerName }) => ({ ...payload, module: ownerName }));
  return { permissions, kinds, roles, sources };
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
    /**
     * Permissions that appear while the application runs (ACCESS-001 §3.1):
     * key prefix → its `PermissionSource` class. The field registers the class;
     * the source owns every key under the prefix.
     */
    readonly permissionSources?: Readonly<Record<string, Class<PermissionSource>>>;
  }
}
