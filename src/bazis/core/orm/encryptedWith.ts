import { createHash } from "node:crypto";
import { Secret, type ConfigDefinition, type ConfigRegistry } from "../kernel";
import { OrmError, type DbContextOptions, type ValueConverter } from "../../library/orm";
import { aesGcmConverter } from "../../library/orm/Metadata/ValueConverter";

interface PendingKey {
  readonly config: ConfigDefinition<object>;
  readonly field: string;
  /** The secret once bound, the configuration it came from, and its fingerprint for a second binding. */
  secret?: string;
  registry?: ConfigRegistry;
  fingerprint?: string;
}

const pending = new WeakMap<object, PendingKey>();

/**
 * AES-256-GCM encryption of a string column with a key from the application
 * configuration. The key is read when the ORM starts — after every
 * configuration source, secret files included, is loaded — so a missing key
 * stops the start instead of failing on the first request:
 *
 * ```ts
 * export const cryptoConfig = defineConfig("crypto", { default: { phoneKey: secret("dev-…") }, production: { phoneKey: secret() } });
 *
 * @HasConversion(encryptedWith(cryptoConfig, "phoneKey"))
 * @Column({ type: "text" })
 * phone = "";
 * ```
 *
 * The secret must be random (`openssl rand -base64 32`): it is hashed with
 * SHA-256, not stretched like a password. Equal values are stored differently,
 * so the column cannot be compared or sorted in SQL.
 */
export function encryptedWith<T extends object>(config: ConfigDefinition<T>, field: keyof T & string): ValueConverter<string, string> {
  const binding: PendingKey = { config: config as ConfigDefinition<object>, field };
  const converter = aesGcmConverter(() => {
    if (binding.secret === undefined) {
      throw new OrmError(`encryptedWith(${label(binding)}): the key is not bound yet; the column is used outside a started application.`);
    }
    return binding.secret;
  });
  pending.set(converter, binding);
  return converter;
}

/**
 * Binds the keys of `encryptedWith` columns of a context to the application
 * configuration. Called by the ORM providers at startup; binding the same
 * column again with another key (two applications in one process) is refused.
 */
export function bindEncryptedColumns(options: DbContextOptions, registry: ConfigRegistry | undefined): void {
  for (const entity of options.model.entities) {
    for (const property of entity.properties) {
      const binding = property.converter === undefined ? undefined : pending.get(property.converter);
      if (binding === undefined || (registry !== undefined && binding.registry === registry)) continue;
      const where = `${entity.name}.${property.propertyName}: encryptedWith(${label(binding)})`;
      if (registry === undefined) throw new OrmError(`${where}: the application configuration is not available.`);
      let view: { get(key: string): unknown };
      try {
        view = registry.get(binding.config) as { get(key: string): unknown };
      } catch {
        throw new OrmError(`${where}: the config "${prefixOf(binding)}" is not declared in the application; add it to \`config\` of the module that owns ${entity.name} or to runApp({ config }).`);
      }
      const value = view.get(binding.field);
      const secret = value instanceof Secret ? value.reveal() : value;
      if (typeof secret !== "string" || secret.length === 0) throw new OrmError(`${where}: the key is empty; set a random secret (openssl rand -base64 32).`);
      const fingerprint = createHash("sha256").update(secret).digest("hex");
      if (binding.fingerprint !== undefined && binding.fingerprint !== fingerprint) {
        throw new OrmError(`${where}: the column is already bound to another key in this process.`);
      }
      binding.secret = secret;
      binding.registry = registry;
      binding.fingerprint = fingerprint;
    }
  }
}

function prefixOf(binding: PendingKey): string {
  return binding.config.token.description.replace(/^Config:/, "");
}

function label(binding: PendingKey): string {
  return `${prefixOf(binding)}.${binding.field}`;
}
