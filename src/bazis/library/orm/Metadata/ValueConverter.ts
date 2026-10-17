import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Value converter between the model (a class property) and the provider (an SQL
 * parameter / column value). Applied before/after the dialect's type encode/decode.
 */
export interface ValueConverter<TModel = unknown, TProvider = unknown> {
  toProvider(value: TModel): TProvider;
  fromProvider(value: TProvider): TModel;
  /**
   * `false`: equal values are stored differently (encryption with a random
   * nonce), so a condition or an ordering on the column cannot work in SQL;
   * the query fails instead of silently matching nothing.
   */
  readonly comparable?: boolean;
}

/** Thrown by an encrypted column that cannot be read: another key, or the stored value was changed. */
export class DecryptionError extends Error {
  constructor() {
    super("cannot decrypt the value: it was encrypted with another key, or the stored value was changed");
    this.name = "DecryptionError";
  }
}

/**
 * AES-256-GCM string encryption with a key that is read on first use.
 * The database stores base64(nonce|ciphertext|tag); the key is the SHA-256 of
 * the secret, so the secret must be random (32 bytes), not a password.
 */
export function aesGcmConverter(secret: () => string): ValueConverter<string, string> {
  let key: Buffer | undefined;
  const keyOf = (): Buffer => (key ??= createHash("sha256").update(secret()).digest());
  return {
    comparable: false,
    toProvider(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyOf(), iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64");
    },
    fromProvider(stored: string): string {
      // Before 0.104.0 an empty string was stored as is.
      if (stored === "") return "";
      const buf = Buffer.from(stored, "base64");
      if (buf.length < 28) throw new DecryptionError();
      const decipher = createDecipheriv("aes-256-gcm", keyOf(), buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(buf.length - 16));
      try {
        return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString("utf8");
      } catch {
        throw new DecryptionError();
      }
    },
  };
}

/** Built-in converters (no external dependencies: Node/Bun `crypto`). */
export const ValueConverters = {
  /**
   * AES-256-GCM at-rest string encryption with a key given in code, for the ORM
   * without an application. In an application take the key from its
   * configuration: `encryptedWith(cryptoConfig, "phoneKey")` from `bazis/core/orm`.
   */
  encrypted(secret: string): ValueConverter<string, string> {
    return aesGcmConverter(() => secret);
  },

  /** JSON <-> string through serialization (for custom structures on top of a text column). */
  json<T>(): ValueConverter<T, string> {
    return {
      toProvider(value: T): string {
        return JSON.stringify(value ?? null);
      },
      fromProvider(stored: string): T {
        return JSON.parse(stored) as T;
      },
    };
  },
};
