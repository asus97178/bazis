/** Strips PEM armor and decodes the base64 payload to DER bytes. */
export function decodePem(pem: string): Uint8Array {
  const body = pem
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith("-----"))
    .join("");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Returns a standalone ArrayBuffer (strict BufferSource for Web Crypto import). */
export function decodePemToBuffer(pem: string): ArrayBuffer {
  const bytes = decodePem(pem);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Wraps DER bytes in PEM armor with the given label. */
export function encodePem(label: string, der: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < der.length; index += 1) {
    binary += String.fromCharCode(der[index]!);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
