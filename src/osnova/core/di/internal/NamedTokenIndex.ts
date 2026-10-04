import { AmbiguousNamedDependencyError } from "../errors";
import { tokenToDebugName, type Token } from "../token";

const AMBIGUOUS = Symbol("osnova.di.ambiguous-name");

/**
 * Maps a token's debug name (`createToken("X")` description or class name) to its
 * token, powering name-based auto deps. Built lazily on first lookup from the
 * full token set; tokens added afterwards (materialized open generics) are
 * indexed incrementally. Distinct tokens sharing a name resolve to an ambiguity
 * marker so a name lookup fails loudly instead of silently picking one.
 */
export class NamedTokenIndex {
  private cache: Map<string, Token<unknown> | typeof AMBIGUOUS> | undefined;

  public constructor(private readonly enumerateTokens: () => Iterable<Token<unknown>>) {}

  public lookup(name: string): Token<unknown> | undefined {
    if (!this.cache) {
      this.cache = new Map();
      for (const token of this.enumerateTokens()) {
        this.indexInternal(token);
      }
    }

    const found = this.cache.get(name);
    if (found === AMBIGUOUS) {
      throw new AmbiguousNamedDependencyError(name);
    }
    return found;
  }

  public index(token: Token<unknown>): void {
    // Before the first lookup the cache is rebuilt from scratch, so eager
    // indexing would be wasted work — defer until the cache exists.
    if (!this.cache) {
      return;
    }
    this.indexInternal(token);
  }

  private indexInternal(token: Token<unknown>): void {
    const cache = this.cache;
    if (!cache) {
      return;
    }
    const name = tokenToDebugName(token);
    const existing = cache.get(name);
    if (existing === undefined) {
      cache.set(name, token);
    } else if (existing !== token) {
      cache.set(name, AMBIGUOUS);
    }
  }
}
