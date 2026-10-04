import type { HostedService } from "../di";
import { getLifecycleConnector, getLifecycleConnectorRole } from "../infra/connectorIdentity";
import { DATABASE_PROVIDER } from "./DATABASE_PROVIDER";

/** ORM interprets the generic Infra binding; Infra has no knowledge of ORM slots. */
export function isOrmProviderLifecycle(lifecycle: HostedService): boolean {
  if ((lifecycle as { __osnovaOrmProviderReady?: unknown }).__osnovaOrmProviderReady === true) return true;
  const connector = getLifecycleConnector(lifecycle);
  return connector?.token === DATABASE_PROVIDER && lifecycle.phase === -110;
}

/** Only these unchanged factory-owned resources may precede application services. */
export function isStrictSchemaPrerequisiteLifecycle(lifecycle: HostedService): boolean {
  if ((lifecycle.phase ?? 0) !== -100) return false;
  const role = getLifecycleConnectorRole(lifecycle);
  return role === "llm" || role === "agent-session-checkpoint-protection";
}
