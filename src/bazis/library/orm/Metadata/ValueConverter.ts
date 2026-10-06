import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Value converter between the model (a class property) and the provider (an SQL
 * parameter / column value). Applied before/after the dialect's type encode/decode.
 */
export interface ValueConverter<TModel = unknown, TProvider = unknown> {
  toProvider(value: TModel): TProvider;
  fromProvider(value: TProvider): TModel;
}

/** Built-in converters (no external dependencies: Node/Bun `crypto`). */
export const ValueConverters = {
  /**
   * AES-256-GCM at-rest string encryption. The database stores base64(nonce|ciphertext|tag).
   * `secret` is the application password/key (derived through SHA-256).
   */
  encrypted(secret: string): ValueConverter<string, string> {
    const key = createHash("sha256").update(secret).digest();
    return {
      toProvider(plaintext: string): string {
        if (plaintext === "") {
          return "";
        }
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, encrypted, tag]).toString("base64");
      },
      fromProvider(stored: string): string {
        if (stored === "") {
          return "";
        }
        const buf = Buffer.from(stored, "base64");
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(buf.length - 16);
        const ciphertext = buf.subarray(12, buf.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      },
    };
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
