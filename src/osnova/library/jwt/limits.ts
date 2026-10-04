/** Compact JWS is ASCII. Bound work before splitting, decoding or cryptography. */
export const DEFAULT_MAX_TOKEN_LENGTH = 16_384;

export function resolveMaxTokenLength(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TOKEN_LENGTH;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("JWT maxTokenLength must be a positive safe integer");
  return value;
}
