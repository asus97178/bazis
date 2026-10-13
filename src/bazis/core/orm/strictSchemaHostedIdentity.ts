import type { HostedService } from "../di";
import { getLifecycleConnector, getLifecycleConnectorRole } from "../infra/connectorIdentity";
import { DATABASE_PROVIDER } from "./DATABASE_PROVIDER";

/** ORM interprets the generic Infra binding; Infra has no knowledge of ORM slots. */
export function isOrmProviderLifecycle(lifecycle: HostedService): boolean {
  if ((lifecycle as { __bazisOrmProviderReady?: unknown }).__bazisOrmProviderReady === true) return true;
  const connector = getLifecycleConnector(lifecycle);
  return connector?.token === DATABASE_PROVIDER && lifecycle.phase === -110;
}

/**
 * Unchanged framework connectors that never touch the schema: they may start
 * at phase -100, after schema admission and before application services.
 */
const PREREQUISITE_ROLES = new Set(["llm", "agent-session-checkpoint-protection", "postgres", "redis", "opensearch"]);

/** Only these unchanged factory-owned resources may precede application services. */
export function isStrictSchemaPrerequisiteLifecycle(lifecycle: HostedService): boolean {
  if ((lifecycle.phase ?? 0) !== -100) return false;
  const role = getLifecycleConnectorRole(lifecycle);
  return role !== undefined && PREREQUISITE_ROLES.has(role);
}

/** The service a phase conflict is about and what to do with it. */
export function describePhaseConflict(service: HostedService): string {
  const name = service.diagnosticName ?? service.constructor?.name ?? "a hosted service";
  const connector = getLifecycleConnector(service) !== undefined;
  return connector
    ? `${name} (phase ${service.phase ?? 0}) is not a framework connector; a custom or changed connector starts at phase 0 or later: set phase: 0 on it.`
    : `${name} has phase ${service.phase ?? 0}; use phase 0 or later.`;
}
