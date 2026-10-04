import type { HostedService, HostedServicePlanValidator } from "../di";
import { SchemaAdmissionError } from "../../library/orm";
import { isOrmProviderLifecycle, isStrictSchemaPrerequisiteLifecycle } from "./strictSchemaHostedIdentity";

/** Stateless strategy shared by ORM lifecycles; it owns no connection or application state. */
export const ormHostedPlanValidator: HostedServicePlanValidator = Object.freeze({ validate: validateOrmHostedPlan });

/** ORM-owned admission rules. Runs before any hosted service starts. */
function validateOrmHostedPlan(services: readonly HostedService[]): void {
  const owned = services.filter((service) => (service as { __osnovaOrmOwnedStoreAdmission?: unknown }).__osnovaOrmOwnedStoreAdmission === true);
  for (const service of owned) {
    if ((service.phase ?? 0) !== -105) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "ORM owned-store admission has an invalid hosted phase.");
    if (!services.some((candidate) => isOrmProviderLifecycle(candidate) && (candidate.phase ?? 0) === -110)) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "ORM owned-store admission requires a provider lifecycle at phase -110.");
  }
  if (owned.length !== 0) {
    for (const service of services) {
      const framework = isOrmProviderLifecycle(service)
        || (service as { __osnovaOrmOwnedStoreAdmission?: unknown }).__osnovaOrmOwnedStoreAdmission === true
        || (service as { __osnovaOrmLegacyLifecycle?: unknown }).__osnovaOrmLegacyLifecycle === true
        || isStrictSchemaPrerequisiteLifecycle(service);
      if (!framework && (service.phase ?? 0) < 0) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Application hosted services must use phase 0 or later with ORM owned-store admission.");
    }
  }
  const strict = services.filter((service): service is HostedService & { readonly __osnovaSchemaAdmission: { readonly unit: readonly string[]; readonly tables: readonly string[]; readonly foreignKeys: readonly { readonly source: string; readonly target: string }[] } } =>
    (service as { __osnovaSchemaAdmission?: unknown }).__osnovaSchemaAdmission !== undefined,
  );
  if (strict.length === 0) return;
  const owners = new Set<string>();
  for (const service of strict) {
    if ((service.phase ?? 0) !== -105) throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Schema admission has an invalid hosted phase.");
    for (const table of service.__osnovaSchemaAdmission.tables) { if (owners.has(table)) throw new SchemaAdmissionError("ORM_SCHEMA_OWNERSHIP_CONFLICT", "Schema admission table ownership conflicts."); owners.add(table); }
    const unit = new Set(service.__osnovaSchemaAdmission.unit);
    for (const foreignKey of service.__osnovaSchemaAdmission.foreignKeys) {
      if (!unit.has(foreignKey.source) || !unit.has(foreignKey.target)) {
        throw new SchemaAdmissionError("ORM_SCHEMA_OWNERSHIP_CONFLICT", "Schema admission foreign keys must target the same explicit unit.");
      }
    }
  }
  if (!services.some((service) => isOrmProviderLifecycle(service) && (service.phase ?? 0) === -110)) {
    throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Schema admission requires a provider lifecycle at phase -110.");
  }
  for (const service of services) {
    if ((service as { __osnovaLegacySchemaAuthority?: unknown }).__osnovaLegacySchemaAuthority === true) {
      throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Schema admission and legacy ORM schema authority cannot be composed together.");
    }
    const framework = isOrmProviderLifecycle(service)
      || isStrictSchemaPrerequisiteLifecycle(service)
      || (service as { __osnovaOrmLegacyLifecycle?: unknown }).__osnovaOrmLegacyLifecycle === true
      || (service as { __osnovaSchemaAdmission?: unknown }).__osnovaSchemaAdmission !== undefined
      || (service as { __osnovaOrmOwnedStoreAdmission?: unknown }).__osnovaOrmOwnedStoreAdmission === true;
    if (!framework && (service.phase ?? 0) < 0) {
      throw new SchemaAdmissionError("ORM_SCHEMA_HOSTED_PHASE_CONFLICT", "Application hosted services must use phase 0 or later with schema admission.");
    }
  }
}
