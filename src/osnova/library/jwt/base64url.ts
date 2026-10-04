const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 base64url encode without padding. Hot path — reuses TextEncoder. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict, canonical RFC 4648 base64url without padding. Empty input decodes to empty bytes. */
export function base64UrlDecode(value: string): Uint8Array {
  if (typeof value !== "string" || /[^A-Za-z0-9_-]/.test(value) || value.length % 4 === 1) {
    throw new TypeError("Malformed base64url");
  }
  const remainder = value.length % 4;
  const last = alphabet.indexOf(value.at(-1) ?? "");
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) {
    throw new TypeError("Non-canonical base64url padding bits");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function base64UrlEncodeString(value: string): string {
  return base64UrlEncode(encoder.encode(value));
}

export function base64UrlDecodeToString(value: string): string {
  return decoder.decode(base64UrlDecode(value));
}

/** Returns the bytes as a standalone ArrayBuffer (strict BufferSource for Web Crypto). */
export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * Byte comparison without a match-position-dependent early return.
 * JavaScript execution has no constant-time guarantee; JWT HMAC verification
 * uses Web Crypto instead. Kept as a compatible public helper.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index]! ^ b[index]!;
  }
  return diff === 0;
}
