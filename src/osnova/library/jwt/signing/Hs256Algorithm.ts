import { toArrayBuffer } from "../base64url";
import type { SigningAlgorithm } from "./SigningAlgorithm";

const encoder = new TextEncoder();

/** Minimum key length for HS256 — matches the SHA-256 output size (RFC 2104). */
export const HS256_MIN_KEY_BYTES = 32;

/**
 * Symmetric HMAC-SHA256 (HS256).
 *
 * The same key both signs and verifies, so it is suitable when a single
 * trusted party issues and validates tokens. The imported {@link CryptoKey}
 * is cached after first use. Caller-owned key bytes are copied immediately.
 */
export class Hs256Algorithm implements SigningAlgorithm {
  public readonly alg = "HS256";
  public readonly canSign = true;

  private readonly keyBytes: Uint8Array;
  private cryptoKey?: CryptoKey;

  public constructor(secret: string | Uint8Array) {
    if (typeof secret !== "string" && !(secret instanceof Uint8Array)) {
      throw new TypeError("HS256 secret must be a string or Uint8Array");
    }
    this.keyBytes = typeof secret === "string" ? encoder.encode(secret) : new Uint8Array(secret);
    if (this.keyBytes.length < HS256_MIN_KEY_BYTES) {
      throw new RangeError(`HS256 secret must be at least ${HS256_MIN_KEY_BYTES} bytes`);
    }
  }

  public async sign(signingInput: string): Promise<Uint8Array> {
    const key = await this.importKey();
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
    return new Uint8Array(signature);
  }

  public async verify(signingInput: string, signature: Uint8Array): Promise<boolean> {
    const key = await this.importKey();
    return crypto.subtle.verify("HMAC", key, toArrayBuffer(signature), encoder.encode(signingInput));
  }

  private async importKey(): Promise<CryptoKey> {
    if (this.cryptoKey !== undefined) {
      return this.cryptoKey;
    }
    this.cryptoKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(this.keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.cryptoKey;
  }
}

/** Convenience factory for {@link Hs256Algorithm}. */
export function hs256(secret: string | Uint8Array): Hs256Algorithm {
  return new Hs256Algorithm(secret);
}
