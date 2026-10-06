/** Base class for every JWT failure. Maps cleanly to HTTP 401 at the edge. */
export class JwtError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Token is structurally invalid (wrong segment count, bad base64, bad JSON). */
export class JwtMalformedError extends JwtError {}

/** Header `alg` does not match the verifying algorithm (blocks `alg` confusion). */
export class JwtAlgorithmError extends JwtError {}

/** Cryptographic signature check failed. */
export class JwtSignatureError extends JwtError {
  public constructor() {
    super("Invalid token signature");
  }
}

/** `exp` claim is in the past (accounting for clock skew). */
export class JwtExpiredError extends JwtError {
  public constructor() {
    super("Token has expired");
  }
}

/** `nbf` claim is in the future (accounting for clock skew). */
export class JwtNotYetValidError extends JwtError {
  public constructor() {
    super("Token is not yet valid");
  }
}

/** A registered claim (`iss`, `aud`, `token_use`, …) failed validation. */
export class JwtClaimError extends JwtError {
  public constructor(
    public readonly claim: string,
    reason: string,
  ) {
    super(`Invalid '${claim}' claim: ${reason}`);
  }
}
