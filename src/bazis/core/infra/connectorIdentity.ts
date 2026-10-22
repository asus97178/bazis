import type { HostedService } from "../di";
import type { InfraConnector } from "./InfraConnector";

type ConnectorIdentity = Readonly<{ role: string; fingerprint: readonly unknown[] }>;
type LifecycleBinding = Readonly<{ connector: InfraConnector; identity?: ConnectorIdentity }>;

const identities = new WeakMap<object, ConnectorIdentity>();
const lifecycles = new WeakMap<object, LifecycleBinding>();
const values = (c: InfraConnector) => [c.token, c.config, c.phase, c.create, c.connect, c.dispose, c.healthCheck, c.providers, c.exports] as const;
const unchanged = (c: InfraConnector, identity: ConnectorIdentity) => values(c).every((value, index) => Object.is(value, identity.fingerprint[index]));

const declarationErrors = new WeakMap<object, unknown>();

/**
 * @internal A connector factory whose options are invalid returns a connector
 * that carries the problem: `@Infra` reports it when the application is built
 * instead of crashing the import of the manifest file.
 */
export function invalidConnector<T>(token: InfraConnector<T>["token"], error: unknown): InfraConnector<T> {
  const connector: InfraConnector<T> = {
    token,
    create() {
      throw error;
    },
    connect() {},
    dispose() {},
  };
  declarationErrors.set(connector, error);
  return connector;
}

/** @internal The declaration problem of a connector made by `invalidConnector`. */
export function connectorDeclarationError(connector: InfraConnector): { readonly error: unknown } | undefined {
  return declarationErrors.has(connector) ? { error: declarationErrors.get(connector) } : undefined;
}

/** @internal A factory identifies its original connector; copies inherit no identity. */
export function identifyConnector<T>(connector: InfraConnector<T>, role: string): InfraConnector<T> {
  identities.set(connector, Object.freeze({ role, fingerprint: values(connector) }));
  return connector;
}

/** @internal Records resource ownership without interpreting role, token or phase. */
export function bindConnectorLifecycle(connector: InfraConnector, lifecycle: HostedService): void {
  const identity = identities.get(connector);
  lifecycles.set(lifecycle, Object.freeze({
    connector,
    identity: identity !== undefined && unchanged(connector, identity) ? identity : undefined,
  }));
}

/** @internal Read-only evidence for the owning integration's plan validator. */
export function getLifecycleConnector(lifecycle: HostedService): InfraConnector | undefined {
  return lifecycles.get(lifecycle)?.connector;
}

/** @internal Both binding-time and current fingerprints must match the original factory result. */
export function getLifecycleConnectorRole(lifecycle: HostedService): string | undefined {
  const binding = lifecycles.get(lifecycle);
  if (binding?.identity === undefined) return undefined;
  return identities.get(binding.connector) === binding.identity && unchanged(binding.connector, binding.identity)
    ? binding.identity.role
    : undefined;
}
