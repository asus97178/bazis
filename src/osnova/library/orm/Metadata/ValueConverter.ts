import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Конвертер значения между моделью (свойство класса) и провайдером (параметр SQL
 * / значение колонки). Применяется до/после типовой encode/decode диалекта.
 */
export interface ValueConverter<TModel = unknown, TProvider = unknown> {
  toProvider(value: TModel): TProvider;
  fromProvider(value: TProvider): TModel;
}

/** Встроенные конвертеры (без внешних зависимостей — Node/Bun `crypto`). */
export const ValueConverters = {
  /**
   * AES-256-GCM шифрование строки at-rest. В БД хранится base64(nonce|ciphertext|tag).
   * `secret` — пароль/ключ приложения (derive через SHA-256).
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

  /** JSON <-> string через сериализацию (для нестандартных структур поверх text-колонки). */
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
