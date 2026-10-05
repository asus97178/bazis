import { base64UrlEncode, base64UrlEncodeString } from "./base64url";
import type { JwtHeader, JwtPayload } from "./claims";
import type { SigningAlgorithm } from "./signing/SigningAlgorithm";
import { JwtKeyRing } from "./JwtKeyRing";
import { resolveMaxTokenLength } from "./limits";

/**
 * Serialises a claim set into a signed compact JWS (`header.payload.signature`).
 *
 * Stateless and bound to a single {@link SigningAlgorithm}; the caller owns
 * claim construction (timestamps, issuer, audience). One encoder per algorithm.
 */
export class JwtEncoder {
  private readonly maxTokenLength: number;

  public constructor(private readonly algorithm: SigningAlgorithm | JwtKeyRing, options: { readonly maxTokenLength?: number } = {}) {
    this.maxTokenLength = resolveMaxTokenLength(options.maxTokenLength);
    if (!(algorithm instanceof JwtKeyRing) && !algorithm.canSign) {
      throw new Error(`Signing algorithm '${algorithm.alg}' has no signing key`);
    }
  }

  public async encode(payload: JwtPayload): Promise<string> {
    const algorithm = this.algorithm instanceof JwtKeyRing ? this.algorithm.signingKey() : this.algorithm;
    const header: JwtHeader = {
      alg: algorithm.alg,
      typ: "JWT",
      ...(algorithm.keyId === undefined ? {} : { kid: algorithm.keyId }),
    };
    const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
      JSON.stringify(payload),
    )}`;
    if (signingInput.length >= this.maxTokenLength) throw new RangeError("JWT exceeds maxTokenLength");
    const signature = await algorithm.sign(signingInput);
    if (this.algorithm instanceof JwtKeyRing) this.algorithm.assertCurrent(algorithm);
    const token = `${signingInput}.${base64UrlEncode(signature)}`;
    if (token.length > this.maxTokenLength) throw new RangeError("JWT exceeds maxTokenLength");
    return token;
  }
}
