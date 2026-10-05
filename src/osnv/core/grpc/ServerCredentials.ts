import type { SecureServerOptions } from "node:http2";

/** TLS configuration uses only the runtime's built-in HTTP/2/TLS implementation. */
export class ServerCredentials {
  private constructor(private readonly settings: SecureServerOptions | undefined) {}

  static createInsecure(): ServerCredentials { return new ServerCredentials(undefined); }
  static createSsl(
    rootCerts: Buffer | null,
    keyCertPairs: readonly { private_key: Buffer; cert_chain: Buffer }[],
    checkClientCertificate = false,
  ): ServerCredentials {
    if (rootCerts !== null && !Buffer.isBuffer(rootCerts)) throw new TypeError("TLS rootCerts must be Buffer or null.");
    if (!Array.isArray(keyCertPairs) || keyCertPairs.length === 0
      || keyCertPairs.some((pair) => !Buffer.isBuffer(pair.private_key) || !Buffer.isBuffer(pair.cert_chain))) {
      throw new TypeError("TLS requires private_key/cert_chain Buffer pairs.");
    }
    if (typeof checkClientCertificate !== "boolean") throw new TypeError("Invalid TLS client certificate policy.");
    return new ServerCredentials({
      ca: rootCerts === null ? undefined : Buffer.from(rootCerts),
      key: keyCertPairs.map((pair) => Buffer.from(pair.private_key)),
      cert: keyCertPairs.map((pair) => Buffer.from(pair.cert_chain)),
      requestCert: checkClientCertificate,
      rejectUnauthorized: checkClientCertificate,
      allowHTTP1: false,
    });
  }
  /** @internal Snapshot for this listener; not a second networking stack. */
  http2Options(): SecureServerOptions | undefined { return this.settings && { ...this.settings }; }
}
