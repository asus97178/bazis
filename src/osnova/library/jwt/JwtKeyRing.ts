import { JwtAlgorithmError, JwtClaimError } from "./errors";
import type { SigningAlgorithm } from "./signing/SigningAlgorithm";

export interface JwtKeyEntry {
  readonly keyId: string;
  readonly algorithm: SigningAlgorithm;
}

export interface JwtKeyRingConfig {
  readonly keys: readonly JwtKeyEntry[];
  /** Omit for a verifier-only ring. */
  readonly activeKeyId?: string;
  /** Explicit, time-bounded migration of tokens issued without kid. Never used for unknown ids. */
  readonly legacy?: { readonly keyId: string; readonly acceptUntil: number };
}

/** A prepared, immutable binding between an id and one crypto strategy. */
export interface SelectedJwtKey extends SigningAlgorithm {
  readonly keyId: string;
}

interface KeySnapshot {
  readonly keys: ReadonlyMap<string, SelectedJwtKey>;
  readonly sources: ReadonlyMap<string, SigningAlgorithm>;
  readonly activeKeyId?: string;
  readonly legacy?: { readonly keyId: string; readonly acceptUntil: number };
}

/** Trusted local key lifecycle. Never resolves token-provided URLs or key material. */
export class JwtKeyRing {
  private revision = 0;
  private readonly revoked = new Set<string>();

  private constructor(private snapshot: KeySnapshot) {}

  /** Checks all keys before exposing the ring to token consumers. */
  public static async create(config: JwtKeyRingConfig): Promise<JwtKeyRing> {
    return new JwtKeyRing(await prepare(config));
  }

  /** Prepare, then publish once. A concurrent replacement/revocation wins over stale work. */
  public async replace(config: JwtKeyRingConfig): Promise<void> {
    const revision = this.revision;
    const candidate = await prepare(config, this.snapshot);
    if (this.revision !== revision) throw new Error("JWT key ring changed during preparation; retry with current configuration");
    for (const id of candidate.keys.keys()) {
      if (this.revoked.has(id)) throw new Error("A revoked JWT key id cannot be restored");
    }
    // Retired ids are never reused during this ring's lifetime.
    for (const id of this.snapshot.keys.keys()) {
      if (!candidate.keys.has(id)) this.revoked.add(id);
    }
    this.snapshot = candidate;
    this.revision += 1;
  }

  /** Immediately distrust an id, including any in-flight use. No crypto or I/O. */
  public revoke(keyId: string): boolean {
    requireKeyId(keyId);
    const keys = new Map(this.snapshot.keys);
    const sources = new Map(this.snapshot.sources);
    const existed = keys.delete(keyId);
    sources.delete(keyId);
    this.revoked.add(keyId);
    this.snapshot = { keys, sources, activeKeyId: this.snapshot.activeKeyId === keyId ? undefined : this.snapshot.activeKeyId,
      legacy: this.snapshot.legacy?.keyId === keyId ? undefined : this.snapshot.legacy };
    this.revision += 1;
    return existed;
  }

  /** Safe operational metadata; no secrets, PEM, or token values. */
  public status() {
    return Object.freeze({
      revision: this.revision,
      activeKeyId: this.snapshot.activeKeyId,
      ...(this.snapshot.legacy === undefined ? {} : { legacy: this.snapshot.legacy }),
      keys: Object.freeze([...this.snapshot.keys.values()].map(key => Object.freeze({ keyId: key.keyId, alg: key.alg, canSign: key.canSign }))),
    });
  }

  /** @internal Captured once by JwtEncoder, before its first await. */
  public signingKey(): SelectedJwtKey {
    const key = this.snapshot.activeKeyId === undefined ? undefined : this.snapshot.keys.get(this.snapshot.activeKeyId);
    if (key === undefined) throw new Error("JWT key ring has no active signing key");
    return key;
  }

  /** @internal The untrusted id selects only an explicitly configured key. */
  public verificationKey(keyId: string | undefined, alg: string): SelectedJwtKey {
    const legacy = this.snapshot.legacy;
    const selectedId = keyId === undefined && legacy !== undefined && Date.now() / 1000 < legacy.acceptUntil
      ? legacy.keyId : keyId;
    const key = selectedId === undefined ? undefined : this.snapshot.keys.get(selectedId);
    if (key === undefined) throw new JwtClaimError("kid", "unknown or missing key id");
    if (alg !== key.alg) throw new JwtAlgorithmError("JWT algorithm does not match the selected key");
    return key;
  }

  /** @internal Linearization check after asynchronous crypto. */
  public assertCurrent(key: SigningAlgorithm): void {
    if (key.keyId === undefined || this.snapshot.keys.get(key.keyId) !== key) throw new JwtClaimError("kid", "key was removed during the operation");
  }
}

async function prepare(config: JwtKeyRingConfig, previous?: KeySnapshot): Promise<KeySnapshot> {
  if (config === null || typeof config !== "object" || Array.isArray(config) ||
      !Array.isArray(config.keys) || config.keys.length < 1 || config.keys.length > 32) {
    throw new TypeError("JWT key ring requires between 1 and 32 keys");
  }
  const activeKeyId = config.activeKeyId;
  if (activeKeyId !== undefined) requireKeyId(activeKeyId);
  let legacy: KeySnapshot["legacy"];
  if (config.legacy !== undefined) {
    if (config.legacy === null || typeof config.legacy !== "object" || Array.isArray(config.legacy)) throw new TypeError("Invalid JWT legacy key policy");
    const { keyId, acceptUntil } = config.legacy;
    requireKeyId(keyId);
    if (typeof acceptUntil !== "number" || !Number.isFinite(acceptUntil) || acceptUntil <= 0) throw new TypeError("JWT legacy acceptUntil must be a positive finite NumericDate");
    legacy = Object.freeze({ keyId, acceptUntil });
  }
  const keys = new Map<string, SelectedJwtKey>();
  const sources = new Map<string, SigningAlgorithm>();
  // Take all metadata snapshots synchronously before calling user crypto strategies.
  for (const entry of [...config.keys]) {
    if (entry === null || typeof entry !== "object") throw new TypeError("Invalid JWT key entry");
    const { keyId, algorithm } = entry;
    requireKeyId(keyId);
    if (keys.has(keyId)) throw new TypeError("Duplicate JWT key id");
    if (algorithm === null || typeof algorithm !== "object" || typeof algorithm.alg !== "string" ||
        algorithm.alg.length === 0 || algorithm.alg.toLowerCase() === "none" ||
        typeof algorithm.canSign !== "boolean" || typeof algorithm.sign !== "function" || typeof algorithm.verify !== "function") {
      throw new TypeError("Invalid JWT signing algorithm");
    }
    if (algorithm.keyId !== undefined && algorithm.keyId !== keyId) throw new TypeError("JWT key id conflicts with algorithm key id");
    const prior = previous?.keys.get(keyId);
    if (prior !== undefined && prior.alg !== algorithm.alg) throw new TypeError("Use a new key id when changing the algorithm");
    const key = prior !== undefined && previous?.sources.get(keyId) === algorithm ? prior : Object.freeze({
      keyId, alg: algorithm.alg, canSign: algorithm.canSign,
      sign: algorithm.sign.bind(algorithm), verify: algorithm.verify.bind(algorithm),
    });
    keys.set(keyId, key);
    sources.set(keyId, algorithm);
  }
  if (activeKeyId !== undefined && !keys.get(activeKeyId)?.canSign) throw new TypeError("Active JWT key must exist and support signing");
  if (legacy !== undefined && !keys.has(legacy.keyId)) throw new TypeError("Legacy JWT key must exist in the trusted set");
  for (const key of keys.values()) {
    if (key === previous?.keys.get(key.keyId)) continue;
    const challenge = `osnova-key-check.${crypto.randomUUID()}`;
    if (key.canSign) {
      const signature = await key.sign(challenge);
      if (!await key.verify(challenge, signature) || await key.verify(`${challenge}.changed`, signature)) {
        throw new Error("JWT signing key self-test failed");
      }
    } else if (await key.verify(challenge, new Uint8Array(0))) {
      throw new Error("JWT verification key accepted an empty signature");
    }
  }
  return { keys, sources, activeKeyId, legacy };
}

function requireKeyId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[^A-Za-z0-9._-]/.test(value)) {
    throw new TypeError("JWT key id must contain 1 to 128 ASCII letters, digits, dots, underscores or hyphens");
  }
}
