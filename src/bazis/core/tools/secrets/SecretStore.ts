import type { Configuration } from "../../kernel";

/** Whose secret is asked for. */
export interface SecretContext {
  /** The partition of the instance: a tenant may have secrets of its own. */
  readonly partition: string | null;
}

/**
 * Values of `$secrets.NAME` (WORKFLOW-002 §7.2): a document holds only the name.
 * The application registers its implementation in any module; by default the
 * values come from the configuration.
 */
export abstract class SecretStore {
  /** The value, or `undefined` when there is no such secret. */
  abstract get(name: string, context: SecretContext): string | undefined | Promise<string | undefined>;
}

/** `secrets.<name>` of the configuration: `BAZIS_SECRETS__API_TOKEN` gives `$secrets.API_TOKEN`. */
export class ConfigSecretStore extends SecretStore {
  constructor(private readonly configuration: Configuration) {
    super();
  }

  get(name: string): string | undefined {
    return this.configuration.get(`secrets.${name}`);
  }
}
