import { TokenIssuer, type TokenIssuerConfig } from "./TokenIssuer";

/**
 * Registry of {@link TokenIssuer}s keyed by token kind.
 *
 * Each kind (e.g. `user`, `admin`, `employee`) is fully isolated: its own
 * signing key and audience. Adding a new kind is purely additive — extend the
 * config map, no existing code changes. The generic key type `K` gives callers
 * compile-time safety over which kinds exist.
 *
 * The concrete kinds are defined by the application, not this library. Pass a
 * string-literal union as `K` for compile-time safety over which kinds exist:
 *
 * @example
 * type Kind = "user" | "admin";
 * const tokens = new TokenService<Kind>({
 *   user:  { issuer, audience: "user",  algorithm: userKey,  accessTtlSeconds: 900, refreshTtlSeconds: 1_209_600 },
 *   admin: { issuer, audience: "admin", algorithm: adminKey, accessTtlSeconds: 600, refreshTtlSeconds: 86_400 },
 * });
 * const pair = await tokens.forKind("user").issue("user-42");
 */
export class TokenService<K extends string = string> {
  private readonly issuers: ReadonlyMap<K, TokenIssuer>;

  public constructor(kinds: Readonly<Record<K, TokenIssuerConfig>>) {
    const entries = (Object.entries(kinds) as Array<[K, TokenIssuerConfig]>).map(
      ([kind, config]) => [kind, new TokenIssuer(config)] as const,
    );
    if (entries.length === 0) {
      throw new Error("TokenService requires at least one token kind");
    }
    this.issuers = new Map(entries);
  }

  /** Returns the issuer for a kind; throws if the kind is not registered. */
  public forKind(kind: K): TokenIssuer {
    const issuer = this.issuers.get(kind);
    if (issuer === undefined) {
      throw new Error(`Unknown token kind '${kind}'`);
    }
    return issuer;
  }

  public has(kind: K): boolean {
    return this.issuers.has(kind);
  }

  public kinds(): readonly K[] {
    return [...this.issuers.keys()];
  }
}
