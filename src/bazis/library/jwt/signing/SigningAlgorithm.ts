/**
 * A pluggable JWT signing/verification strategy (HS256, RS256, …).
 *
 * Implementations must be stateless from the caller's perspective and may
 * cache imported {@link CryptoKey}s internally to keep the verify path fast.
 */
export interface SigningAlgorithm {
  /** JWS `alg` header value (e.g. `HS256`, `RS256`). */
  readonly alg: string;
  /** Optional `kid` written to the header and matched on verify. */
  readonly keyId?: string;
  /** Whether this instance holds the secret/private key needed to sign. */
  readonly canSign: boolean;
  /** Produces the signature bytes for the `header.payload` signing input. */
  sign(signingInput: string): Promise<Uint8Array>;
  /** Constant-time / cryptographic verification of a detached signature. */
  verify(signingInput: string, signature: Uint8Array): Promise<boolean>;
}
