import type { HostedService, HostedServicePlanValidator } from "../di";
import { SchemaAdmissionError } from "../../library/orm";
import { isOrmProviderLifecycle, isStrictSchemaPrerequisiteLifecycle } from "./strictSchemaHostedIdentity";

/** Stateless strategy shared by ORM lifecycles; it owns no connection or application state. */
export const ormHostedPlanValidator: HostedServicePlanValidator = Object.freeze({ validate: validateOrmHostedPlan });

/** ORM-owned admission rules. Runs before any hosted service starts. */
function validateOrmHostedPlan(services: readonly HostedService[]): void {
  const owned = services.filter((service) => (service as { __bazisOrmOwnedStoreAdmission?: unknown }).__bazisOrmOwnedStoreAdmission === true);
  for (const service of owned) {
    if ((service.phase ?? 0) !== -105) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "ORM owned-store admission has an invalid hosted phase.");
    if (!services.some((candidate) => isOrmProviderLifecycle(candidate) && (candidate.phase ?? 0) === -110)) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "ORM owned-store admission requires a provider lifecycle at phase -110.");
  }
  if (owned.length !== 0) {
    for (const service of services) {
      const framework = isOrmProviderLifecycle(service)
        || (service as { __bazisOrmOwnedStoreAdmission?: unknown }).__bazisOrmOwnedStoreAdmission === true
        || (service as { __bazisOrmLegacyLifecycle?: unknown }).__bazisOrmLegacyLifecycle === true
        || isStrictSchemaPrerequisiteLifecycle(service);
      if (!framework && (service.phase ?? 0) < 0) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Application hosted services must use phase 0 or later with ORM owned-store admission.");
    }
  }
  const strict = services.filter((service): service is HostedService & { readonly __bazisSchemaAdmission: { readonly owner?: string; readonly unit: readonly string[]; readonly tables: readonly string[]; readonly foreignKeys: readonly { readonly source: string; readonly target: string }[] } } =>
    (service as { __bazisSchemaAdmission?: unknown }).__bazisSchemaAdmission !== undefined,
  );
  if (strict.length === 0) return;
  const owners = new Map<string, string>();
  for (const service of strict) {
    if ((service.phase ?? 0) !== -105) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Schema admission has an invalid hosted phase.");
    const owner = service.__bazisSchemaAdmission.owner ?? "A DbContext";
    for (const table of service.__bazisSchemaAdmission.tables) {
      const other = owners.get(table);
      if (other !== undefined) throw new SchemaAdmissionError("ORM_SCHEMA_OWNERSHIP_CONFLICT", `Schema admission table ownership conflicts: table ${table} is created by both ${other} and ${owner} with ensureCreated. One context must own the table: remove the entity from the other context and refer to it by a plain id column.`);
      owners.set(table, owner);
    }
    const unit = new Set(service.__bazisSchemaAdmission.unit);
    for (const foreignKey of service.__bazisSchemaAdmission.foreignKeys) {
      if (!unit.has(foreignKey.source) || !unit.has(foreignKey.target)) {
        throw new SchemaAdmissionError("ORM_SCHEMA_OWNERSHIP_CONFLICT", `Schema admission foreign keys must target the same explicit unit: ${owner} has a foreign key from ${foreignKey.source} to ${foreignKey.target}, which it does not create.`);
      }
    }
  }
  if (!services.some((service) => isOrmProviderLifecycle(service) && (service.phase ?? 0) === -110)) {
    throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Schema admission requires a provider lifecycle at phase -110.");
  }
  const legacy = services.filter((service) => (service as { __bazisLegacySchemaAuthority?: unknown }).__bazisLegacySchemaAuthority === true);
  if (legacy.length > 0) {
    const describe = (service: HostedService) => {
      const owner = (service as { __bazisSchemaOwner?: { context: string; mode: string } }).__bazisSchemaOwner;
      return owner ? `${owner.context} uses ${owner.mode}` : "a module uses migrateOnStart or migrations";
    };
    throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", `Schema admission and legacy ORM schema authority cannot be composed together: ${[...strict, ...legacy].map(describe).join(", ")}. Use one schema mode in the application: ensureCreated (with or without migrations) in every module, or migrateOnStart/migrations without ensureCreated in every module.`);
  }
  for (const service of services) {
    const framework = isOrmProviderLifecycle(service)
      || isStrictSchemaPrerequisiteLifecycle(service)
      || (service as { __bazisOrmLegacyLifecycle?: unknown }).__bazisOrmLegacyLifecycle === true
      || (service as { __bazisSchemaAdmission?: unknown }).__bazisSchemaAdmission !== undefined
      || (service as { __bazisOrmOwnedStoreAdmission?: unknown }).__bazisOrmOwnedStoreAdmission === true;
    if (!framework && (service.phase ?? 0) < 0) {
      throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Application hosted services must use phase 0 or later with schema admission.");
    }
  }
}
